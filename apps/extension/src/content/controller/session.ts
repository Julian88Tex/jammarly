/**
 * FieldSession: everything one attached field needs between the adapter/UI interfaces and the service worker
 * (ARCHITECTURE §3.1, §3.2, §3.4, §3.7). Owns the text model, the suggestion store, the pass scheduler, the apply
 * engine and the feedback tracker; drives one FieldOverlay; speaks ContentToWorker/WorkerToContent through the
 * registry's port.
 */
import type {
  AcceptAllScope,
  CheckError,
  CheckPass,
  CheckRequest,
  CheckResult,
  ContentToWorker,
  DismissReason,
  Edit,
  EffectiveConfig,
  FieldKind,
  FieldState,
  FieldStatus,
  PanelAction,
  RuntimeRequest,
  Suggestion,
  SuggestionCategory,
  TextRange,
  TokenUsage,
  ToneAnalysis,
  WorkerToContent,
} from '@jammarly/shared/types';
import { PASS_RANK } from '@jammarly/shared/types';
import type { FeedbackVia } from '@jammarly/shared/learning';
import { computeScore, countWords, hashText, rebaseSuggestions, splitParagraphs, stripUrlsAndCode } from '@jammarly/shared/text';
import { hitsToSuggestions, runRules } from '@jammarly/shared/rules';
import { PROMPT_VERSION } from '@jammarly/shared/prompts/prompt-text';
import { shouldStoreSnippet } from '@jammarly/shared/redact';
import type { FieldAdapter, SiteProfile } from '../field-adapter';
import type { FieldOverlay, Overlay, OverlayOptions, UnderlineItem } from '../ui/overlay-api';
import { ApplyEngine } from './apply';
import { FeedbackTracker } from './feedback';
import { passFor, Scheduler, type PassTrigger, type RequestedPass, type SchedulerConfig } from './scheduler';
import { selectAcceptAll, SuggestionStore, type StoreFilters } from './store';
import { TextModel } from './text-model';
import { computeDocKey, fieldPath, randomToken, realTimers, type Timers } from './util';

export const TYPING_IDLE_MS = 600;
export const FEEDBACK_IDLE_MS = 1000;
export const FIELD_STATE_DEBOUNCE_MS = 250;
/** Single-line inputs get Claude passes only once they hold this many words (ARCHITECTURE §3.4). */
export const INPUT_MIN_WORDS = 3;
export const TEXT_PREVIEW_CHARS = 80;
export const SINGLE_ACCEPT_TOAST_MS = 8000;

export type FieldStatePayload = Omit<FieldState, 'tabId' | 'frameId'>;

export interface SessionDeps {
  fieldId: string;
  element: HTMLElement;
  adapter: FieldAdapter;
  profile: SiteProfile;
  kind: FieldKind;
  label: string;
  host: string;
  origin: string;
  overlay: Overlay;
  getConfig(): EffectiveConfig;
  /** False until the worker's first `config` message (the profile's context is used meanwhile). */
  configReceived(): boolean;
  send(msg: ContentToWorker): boolean;
  sendRuntime(msg: RuntimeRequest): void;
  setOutstanding(key: string, outstanding: boolean): void;
  timers?: Timers;
}

interface Inflight {
  version: number;
  textHash: string;
  request: CheckRequest;
}

export function overlayOptionsFor(config: EffectiveConfig, profile: SiteProfile): OverlayOptions {
  return {
    theme: { colorblindMode: config.colorblindMode },
    shortcutSafe: profile.shortcutSafe || config.shortcutSafeMode,
    showFloatingButton: config.showFloatingButton,
    showUnderlines: config.showUnderlines,
  };
}

export interface StatusInput {
  enabled: boolean;
  consented: boolean;
  engineReady: boolean;
  error: CheckError | undefined;
  checking: boolean;
  suggestionCount: number;
  hasText: boolean;
  checkedBy: CheckPass;
}

/** Floating-button status (ARCHITECTURE §3.1 first run, §3.5 states). Pure. */
export function computeStatus(input: StatusInput): FieldStatus {
  if (!input.enabled) return 'off';
  if (!input.consented || !input.engineReady) return 'setup';
  if (input.error && input.error.code !== 'cancelled') {
    if (input.error.code === 'consent-required' || input.error.code === 'no-api-key') return 'setup';
    if (input.error.code === 'disabled') return 'off';
    return 'error';
  }
  if (input.suggestionCount > 0) return 'suggestions';
  if (input.checking) return 'checking';
  if (input.hasText && input.checkedBy !== 'rules') return 'clean';
  return 'idle';
}

/** Rounds "Accept everything" runs at most; each round re-checks with Claude, so this also caps the cost. */
const MAX_SWEEP_ROUNDS = 3;

function sweepDoneText(total: number, rounds: number): string {
  return rounds > 1 ? `Fixed ${total} issue${total === 1 ? '' : 's'} in ${rounds} rounds` : `Applied ${total} change${total === 1 ? '' : 's'}`;
}

function passRank(pass: CheckPass | undefined): number {
  return pass === undefined ? -1 : PASS_RANK[pass];
}

export class FieldSession {
  readonly fieldId: string;
  readonly element: HTMLElement;
  readonly adapter: FieldAdapter;
  readonly profile: SiteProfile;
  readonly kind: FieldKind;
  readonly label: string;
  readonly model: TextModel;
  readonly store: SuggestionStore;
  readonly scheduler: Scheduler;
  readonly apply: ApplyEngine;
  readonly feedback: FeedbackTracker;
  readonly ui: FieldOverlay;

  private readonly deps: SessionDeps;
  private readonly timers: Timers;
  private inflight: Partial<Record<RequestedPass, Inflight>> = {};
  /** Pending re-send after Anthropic rate-limited a check (the worker already retried twice). */
  private readonly rateLimitTimers: Partial<Record<RequestedPass, ReturnType<typeof setTimeout>>> = {};
  private readonly rateLimitRetries: Partial<Record<RequestedPass, number>> = {};
  private readonly checked = new Map<string, CheckPass>();
  private everChecked = false;
  /** "Accept everything" keeps going: apply, re-check the changed text, apply that round's fixes, until clean. */
  private sweep: { scope: AcceptAllScope; round: number; total: number; lastTx: string; txIds: string[]; pass?: RequestedPass } | null = null;
  /** A finished multi-round sweep: its toast's Undo (keyed by the last round's transaction) reverts every round. */
  private readonly sweepGroups = new Map<string, string[]>();
  private deepScheduled = false;
  private lastError: CheckError | undefined;
  private toneValue: ToneAnalysis | undefined;
  private usage: TokenUsage | undefined;
  private focused: boolean;
  private fieldEnabled = true;
  private disposed = false;
  private own: { ids: Set<string>; startVersion: number } | null = null;
  private typingTimer: unknown = null;
  private idleTimer: unknown = null;
  private stateTimer: unknown = null;
  private layoutFrame: unknown = null;
  private readonly unsubs: (() => void)[] = [];
  private readonly localDictionary = new Set<string>();
  private readonly localMuted = new Set<string>();
  private docKeyValue: string;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
    this.fieldId = deps.fieldId;
    this.element = deps.element;
    this.adapter = deps.adapter;
    this.profile = deps.profile;
    this.kind = deps.kind;
    this.label = deps.label;
    this.model = new TextModel(this.safeText());
    this.store = new SuggestionStore();
    this.store.setFilters(this.filters());
    this.docKeyValue = this.computeDocKey();
    this.feedback = new FeedbackTracker({
      fieldId: this.fieldId,
      host: deps.host,
      ctx: () => this.context(),
      docKey: () => this.docKeyValue,
      snippetsAllowed: () => this.snippetsAllowed(),
      send: (events) => {
        this.deps.send({ type: 'feedback', events });
      },
      sendVoice: (samples) => {
        this.deps.send({ type: 'voice-samples', samples });
      },
      timers: this.timers,
    });
    this.apply = new ApplyEngine({
      fieldId: this.fieldId,
      adapter: this.adapter,
      model: this.model,
      store: this.store,
      beginOwnEdit: (edits, ids) => this.beginOwnEdit(edits, ids),
      endOwnEdit: (text) => this.endOwnEdit(text),
      now: () => this.timers.now(),
      newId: () => `tx-${randomToken(6)}`,
      timers: this.timers,
    });
    this.scheduler = new Scheduler(
      { runRules: () => this.runLocalRules(), requestPass: (pass, trigger) => this.requestPass(pass, trigger) },
      this.schedulerConfig(),
      this.timers,
    );
    this.focused = this.safely(() => this.adapter.isFocused(), false);
    this.ui = deps.overlay.attach(this.fieldId, this.adapter, overlayOptionsFor(deps.getConfig(), deps.profile));
    this.unsubs.push(this.adapter.onChange((text, inputType) => this.onChange(text, inputType)));
    this.unsubs.push(this.adapter.onLayout(() => this.onLayout()));
    this.unsubs.push(this.adapter.onFocusChange((focused) => this.onFocusChange(focused)));
    this.deps.send({ type: 'field-attached', fieldId: this.fieldId, fieldKind: this.kind, label: this.label, docKey: this.docKeyValue });
    this.scheduler.runRulesNow();
    this.scheduler.attach(this.canCheck());
    this.refresh();
  }

  // ---------------------------------------------------------------------------------------------
  // Public state
  // ---------------------------------------------------------------------------------------------

  get text(): string {
    return this.model.text;
  }

  get docKey(): string {
    return this.docKeyValue;
  }

  get tone(): ToneAnalysis | undefined {
    return this.toneValue;
  }

  get isFocused(): boolean {
    return this.focused;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get inflightPasses(): RequestedPass[] {
    return Object.keys(this.inflight) as RequestedPass[];
  }

  get error(): CheckError | undefined {
    return this.lastError;
  }

  isEnabled(): boolean {
    const c = this.deps.getConfig();
    return this.fieldEnabled && c.enabled && c.enabledOnHost;
  }

  context(): EffectiveConfig['context'] {
    return this.deps.configReceived() ? this.deps.getConfig().context : this.profile.context;
  }

  status(): FieldStatus {
    const c = this.deps.getConfig();
    return computeStatus({
      enabled: this.isEnabled(),
      consented: c.consented,
      engineReady: c.engineReady,
      error: this.lastError,
      checking: this.inflightPasses.length > 0 || this.deepScheduled,
      suggestionCount: this.store.all.length,
      hasText: this.model.text.trim().length > 0,
      checkedBy: this.checkedBy(),
    });
  }

  /** Highest pass that has covered every non-blank block ('rules' until the engine answers). */
  checkedBy(): CheckPass {
    const blocks = splitParagraphs(this.model.text).filter((b) => b.text.trim().length > 0);
    if (blocks.length === 0) return 'rules';
    let best: CheckPass = 'deep';
    for (const b of blocks) {
      const pass = this.checked.get(b.hash) ?? 'rules';
      if (PASS_RANK[pass] < PASS_RANK[best]) best = pass;
    }
    return best;
  }

  fieldState(): FieldStatePayload {
    const text = this.model.text;
    const status = this.status();
    const state: FieldStatePayload = {
      fieldId: this.fieldId,
      host: this.deps.host,
      fieldKind: this.kind,
      label: this.label,
      version: this.model.version,
      textPreview: text.slice(0, TEXT_PREVIEW_CHARS),
      wordCount: countWords(text),
      suggestions: [...this.store.all],
      status,
      checkedBy: this.checkedBy(),
      active: this.focused,
      undoAvailable: this.apply.undoAvailable,
      transactions: this.apply.history,
    };
    if (this.toneValue) state.tone = this.toneValue;
    state.score = computeScore(text, [...this.store.all]);
    if (status === 'error' && this.lastError) state.error = this.lastError;
    if (this.usage) state.usage = this.usage;
    return state;
  }

  // ---------------------------------------------------------------------------------------------
  // Worker messages
  // ---------------------------------------------------------------------------------------------

  handleMessage(msg: WorkerToContent): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'check-progress':
        if (msg.fieldId !== this.fieldId) return;
        if (msg.stage === 'deep-scheduled') this.deepScheduled = true;
        this.refresh();
        return;
      case 'check-result':
        if (msg.result.fieldId !== this.fieldId) return;
        this.handleResult(msg.result);
        return;
      case 'tone':
        if (msg.fieldId !== this.fieldId || msg.version > this.model.version) return;
        this.toneValue = msg.tone;
        this.ui.setTone(this.isEnabled() ? this.toneValue : undefined, this.model.text.length);
        this.scheduleFieldState();
        return;
      case 'panel-action':
        if (msg.action.fieldId !== this.fieldId) return;
        this.handlePanelAction(msg.action);
        return;
      default:
        return;
    }
  }

  handlePanelAction(action: PanelAction): void {
    if (this.disposed || action.fieldId !== this.fieldId) return;
    switch (action.type) {
      case 'accept':
        void this.accept(action.suggestionId, action.alternativeIndex, 'panel');
        return;
      case 'dismiss':
        this.dismiss(action.suggestionId, action.reason, 'panel');
        return;
      case 'accept-all':
        void this.acceptAll(action.scope, 'bulk');
        return;
      case 'focus':
        this.focusSuggestion(action.suggestionId);
        return;
      case 'recheck':
        this.recheck();
        return;
      case 'undo':
        void this.undo(action.transactionId);
        return;
      case 'revert':
        void this.revert(action.suggestionId);
        return;
      case 'dismiss-all':
        this.dismissAll(action.category);
        return;
      case 'set-field-enabled':
        this.setFieldEnabled(action.enabled);
        return;
      default:
        return;
    }
  }

  /** The worker's config changed (or arrived): filters, cadence, docKey, status. */
  configChanged(): void {
    if (this.disposed) return;
    this.store.setFilters(this.filters());
    this.scheduler.setConfig(this.schedulerConfig());
    const key = this.computeDocKey();
    if (key !== this.docKeyValue) {
      this.docKeyValue = key;
      this.deps.send({ type: 'field-attached', fieldId: this.fieldId, fieldKind: this.kind, label: this.label, docKey: key });
    }
    if (!this.isEnabled()) {
      this.cancelInflight();
      this.ui.closeCard();
    }
    this.scheduler.runRulesNow();
    if (this.canCheck() && !this.everChecked && this.inflightPasses.length === 0) this.scheduler.attach(true);
    this.refresh();
  }

  /** After a reconnect: re-send every outstanding check whose text hash is unchanged. */
  resendOutstanding(): void {
    for (const pass of this.inflightPasses) {
      const entry = this.inflight[pass];
      if (!entry) continue;
      if (hashText(this.model.text) === entry.textHash) this.deps.send({ type: 'check', request: entry.request });
      else {
        delete this.inflight[pass];
        this.deps.setOutstanding(this.outstandingKey(pass), false);
      }
    }
    this.refresh();
  }

  // ---------------------------------------------------------------------------------------------
  // User actions (overlay events and panel actions)
  // ---------------------------------------------------------------------------------------------

  async accept(suggestionId: string, alternativeIndex?: number, via: FeedbackVia = 'card'): Promise<boolean> {
    if (this.disposed) return false;
    const result = await this.apply.accept(suggestionId, alternativeIndex);
    if (this.disposed) return false;
    if (result.status === 'applied' && result.transaction && result.suggestion) {
      const tx = result.transaction;
      const post = tx.edits[0]!;
      this.feedback.accept(result.suggestion, via, this.model.text, result.replacement ?? result.suggestion.replacement, { version: this.model.version, range: post.range });
      this.deps.send({ type: 'apply-report', report: { fieldId: this.fieldId, appliedIds: [suggestionId], skippedIds: [], pendingRewriteIds: [], transactionId: tx.id } });
      this.ui.closeCard();
      this.ui.toast('Applied', { undoTransactionId: tx.id, durationMs: SINGLE_ACCEPT_TOAST_MS });
      this.scheduler.afterApply();
      this.refresh();
      return true;
    }
    if (result.status === 'mismatch') {
      this.store.remove([suggestionId]);
      this.ui.toast("Couldn't apply: the text changed");
    } else if (result.status === 'protected') this.ui.toast("Couldn't apply inside protected text");
    else if (result.status === 'composing') this.ui.toast('Finish typing first');
    else if (result.status === 'failed') this.ui.toast("Couldn't apply this suggestion here");
    this.refresh();
    return false;
  }

  dismiss(suggestionId: string, reason: DismissReason | undefined, via: FeedbackVia = 'card'): void {
    if (this.disposed) return;
    const s = this.store.get(suggestionId);
    if (!s) return;
    this.store.dismiss(s);
    this.feedback.dismiss(s, reason, via, this.model.text);
    const msg: ContentToWorker = { type: 'dismiss', fieldId: this.fieldId, suggestionId, fingerprint: s.fingerprint, rule: s.rule, docKey: this.docKeyValue };
    if (reason !== undefined) msg.reason = reason;
    this.deps.send(msg);
    this.ui.closeCard();
    this.refresh();
  }

  /** Grammarly's per-category trash: every pending suggestion of the category, "not here" semantics, no profile mutation. */
  dismissAll(category: SuggestionCategory): void {
    if (this.disposed) return;
    const targets = this.store.all.filter((s) => s.category === category);
    for (const s of targets) {
      this.store.dismiss(s);
      this.feedback.dismiss(s, 'not_here', 'panel', this.model.text);
      this.deps.send({ type: 'dismiss', fieldId: this.fieldId, suggestionId: s.id, fingerprint: s.fingerprint, rule: s.rule, docKey: this.docKeyValue, reason: 'not_here' });
    }
    this.ui.closeCard();
    this.refresh();
  }

  async acceptAll(scope: AcceptAllScope, via: FeedbackVia = 'bulk', continuing = false): Promise<number> {
    if (this.disposed) return 0;
    if (!continuing) this.sweep = null;
    const result = await this.apply.acceptAll(scope);
    if (this.disposed) return 0;
    if (result.transaction && result.report) {
      const tx = result.transaction;
      result.applied.forEach((s, i) => {
        const post = tx.edits[i];
        const item = tx.items[i];
        if (!post || !item) return;
        this.feedback.accept(s, via, this.model.text, item.replacement, { version: this.model.version, range: post.range });
      });
      this.deps.send({ type: 'apply-report', report: result.report });
      const n = result.applied.length;
      this.ui.closeCard();
      // A whole-field bulk accept (not a sentence card's explicit subset) sweeps: the fixes often reveal new ones.
      const sweeping = scope.suggestionIds === undefined;
      const round = continuing && this.sweep ? this.sweep.round + 1 : 1;
      const total = (continuing && this.sweep ? this.sweep.total : 0) + n;
      const txIds = [...(continuing && this.sweep ? this.sweep.txIds : []), tx.id];
      if (sweeping && round < MAX_SWEEP_ROUNDS) {
        // No toast until the sweep ends: one toast reports the total, and its Undo reverts every round.
        this.sweep = { scope, round, total, lastTx: tx.id, txIds };
      } else {
        this.sweep = null;
        this.rememberSweep(txIds);
        this.ui.toast(sweepDoneText(total, round), { undoTransactionId: tx.id });
      }
      if (scope.group !== 'grammar' && result.pendingRewrites.length > 0 && this.sweep === null) {
        const k = result.pendingRewrites.length;
        this.ui.toast(`${k} rewrite${k === 1 ? '' : 's'} need${k === 1 ? 's' : ''} your choice`);
      }
      this.scheduler.afterApply();
      this.refresh();
      if (this.sweep) {
        // Rules see the new text now; the Claude pass for the changed paragraphs is requested right away and the
        // sweep continues when it lands (handleResult). Without Claude, the rules alone decide the next round.
        this.runLocalRules();
        if (this.canCheck()) {
          const pass = passFor('deep', this.deps.getConfig().mode);
          this.sweep.pass = pass;
          this.requestPass(pass, 'after-apply');
        } else void this.continueSweep();
      }
      return n;
    }
    if (continuing && this.sweep) {
      this.finishSweep();
      return 0;
    }
    if (result.skipped.length > 0) this.ui.toast("Couldn't apply these changes here");
    else if (scope.suggestionIds === undefined) {
      // A shortcut press with nothing to do still answers, so it never looks like it was ignored.
      const k = scope.group === 'grammar' ? 0 : result.pendingRewrites.length;
      this.ui.toast(k > 0 ? `${k} rewrite${k === 1 ? '' : 's'} need${k === 1 ? 's' : ''} your choice` : 'Nothing left to fix');
    }
    this.refresh();
    return 0;
  }

  /** Next sweep round once the re-check is in: apply what it found, or report the total when nothing is left. */
  private async continueSweep(): Promise<void> {
    const sweep = this.sweep;
    if (!sweep || this.disposed) return;
    this.runLocalRules();
    if (selectAcceptAll(this.store.all, sweep.scope).selected.length === 0) {
      this.finishSweep();
      return;
    }
    await this.acceptAll(sweep.scope, 'bulk', true);
  }

  private finishSweep(): void {
    const sweep = this.sweep;
    this.sweep = null;
    if (!sweep) return;
    this.rememberSweep(sweep.txIds);
    this.ui.toast(sweepDoneText(sweep.total, sweep.round), { undoTransactionId: sweep.lastTx });
    this.refresh();
  }

  private rememberSweep(txIds: string[]): void {
    const last = txIds[txIds.length - 1];
    if (last === undefined || txIds.length < 2) return;
    this.sweepGroups.set(last, [...txIds]);
    if (this.sweepGroups.size > 10) this.sweepGroups.delete(this.sweepGroups.keys().next().value as string);
  }

  async undo(transactionId?: string): Promise<number> {
    if (this.disposed) return 0;
    // A multi-round "Accept everything" is one action for the user: undo every round, newest first.
    const group = transactionId ? this.sweepGroups.get(transactionId) : undefined;
    if (transactionId && group) this.sweepGroups.delete(transactionId);
    const ids = group ? [...group].reverse() : [transactionId];
    let reverted = 0;
    let partial = false;
    let failed = false;
    for (const id of ids) {
      const result = await this.apply.undo(id);
      if (this.disposed) return 0;
      reverted += result.revertedIds.length;
      if (result.status === 'partial') partial = true;
      if (result.status === 'failed') failed = true;
    }
    if (reverted > 0) {
      this.ui.toast(partial || failed ? 'Undone (some changes were already edited)' : 'Undone');
      this.scheduler.afterApply();
    } else if (failed) this.ui.toast("Couldn't undo: the text changed");
    this.refresh();
    return reverted;
  }

  async revert(suggestionId: string): Promise<boolean> {
    if (this.disposed) return false;
    const result = await this.apply.revert(suggestionId);
    if (this.disposed) return false;
    if (result.revertedIds.length > 0) {
      this.ui.toast('Reverted');
      this.scheduler.afterApply();
    } else if (result.status === 'failed') this.ui.toast("Couldn't revert: the text changed");
    this.refresh();
    return result.revertedIds.length > 0;
  }

  addToDictionary(word: string): void {
    if (this.disposed) return;
    const w = word.trim();
    if (w.length === 0) return;
    this.deps.send({ type: 'add-to-dictionary', word: w });
    this.localDictionary.add(w.toLowerCase());
    for (const s of this.store.all) {
      if (s.original.trim().toLowerCase() === w.toLowerCase()) {
        this.feedback.addToDictionary(s, this.model.text);
        this.store.dismiss(s);
      }
    }
    this.store.setFilters(this.filters());
    this.ui.closeCard();
    this.scheduler.runRulesNow();
    this.refresh();
  }

  muteRule(rule: string, scope: 'host' | 'global'): void {
    if (this.disposed) return;
    this.deps.send({ type: 'mute-rule', rule, scope });
    this.localMuted.add(rule);
    this.store.setFilters(this.filters());
    this.ui.closeCard();
    this.scheduler.runRulesNow();
    this.refresh();
  }

  reportIncorrect(suggestionId: string): void {
    if (this.disposed) return;
    const s = this.store.get(suggestionId);
    if (!s) return;
    this.feedback.reportIncorrect(s, this.model.text);
    this.store.dismiss(s);
    this.deps.send({ type: 'dismiss', fieldId: this.fieldId, suggestionId, fingerprint: s.fingerprint, rule: s.rule, docKey: this.docKeyValue, reason: 'not_error' });
    this.ui.closeCard();
    this.refresh();
  }

  openPanel(): void {
    this.deps.sendRuntime({ type: 'open-side-panel' });
  }

  openSetup(): void {
    this.deps.sendRuntime({ type: 'open-options', hash: 'welcome' });
  }

  recheck(): void {
    if (this.disposed) return;
    this.scheduler.checkNow();
  }

  /** Panel "focus": scroll the field into view, place the caret and open the card. */
  focusSuggestion(suggestionId: string): void {
    if (this.disposed) return;
    const s = this.store.get(suggestionId);
    if (!s) return;
    this.safely(() => this.adapter.focus(), undefined);
    const el = this.element as HTMLElement & { scrollIntoView?: (opts?: ScrollIntoViewOptions) => void };
    if (typeof el.scrollIntoView === 'function') this.safely(() => el.scrollIntoView!({ block: 'center' }), undefined);
    this.safely(() => this.adapter.setSelection({ start: s.range.start, end: s.range.start }), undefined);
    const rects = this.rects(s.highlight);
    this.ui.openCard(suggestionId, rects[0] ?? this.safely(() => this.adapter.getBox(), new DOMRect()));
  }

  cardShown(suggestionId: string): void {
    const s = this.store.get(suggestionId);
    if (s) this.feedback.cardShown(s, this.model.text);
  }

  cardHidden(suggestionId: string): void {
    this.feedback.cardHidden(this.store.get(suggestionId), suggestionId, this.model.text);
  }

  /** "Turn off this field" (session scope; a 'forever' duration needs a worker message the contract does not have yet). */
  setFieldEnabled(enabled: boolean): void {
    if (this.disposed || this.fieldEnabled === enabled) return;
    this.fieldEnabled = enabled;
    if (!enabled) {
      this.cancelInflight();
      this.ui.closeCard();
    }
    this.scheduler.runRulesNow();
    if (enabled && this.canCheck() && !this.everChecked) this.scheduler.attach(true);
    this.refresh();
  }

  flushFeedback(): void {
    this.feedback.flush();
  }

  /** Re-sends a rate-limited check once the cooldown passes, if the text is unchanged; at most 3 times in a row. */
  private scheduleRateLimitRetry(pass: RequestedPass, entry: Inflight, retryAfterMs: number | undefined): void {
    const attempt = (this.rateLimitRetries[pass] ?? 0) + 1;
    if (attempt > 3) return;
    this.rateLimitRetries[pass] = attempt;
    const pending = this.rateLimitTimers[pass];
    if (pending !== undefined) clearTimeout(pending);
    const wait = Math.min(60_000, Math.max(5_000, retryAfterMs ?? 15_000) * attempt);
    this.rateLimitTimers[pass] = setTimeout(() => {
      delete this.rateLimitTimers[pass];
      if (this.disposed || this.inflight[pass] || !this.isEnabled() || hashText(this.model.text) !== entry.textHash) return;
      this.inflight[pass] = entry;
      this.deps.setOutstanding(this.outstandingKey(pass), true);
      this.deps.send({ type: 'check', request: entry.request });
      this.refresh();
    }, wait);
  }

  dispose(): void {
    if (this.disposed) return;
    for (const t of Object.values(this.rateLimitTimers)) if (t !== undefined) clearTimeout(t);
    this.cancelInflight();
    this.feedback.dispose();
    this.deps.send({ type: 'field-detached', fieldId: this.fieldId });
    this.disposed = true;
    this.scheduler.dispose();
    for (const t of [this.typingTimer, this.idleTimer, this.stateTimer]) if (t !== null) this.timers.clearTimeout(t);
    if (this.layoutFrame !== null) this.timers.cancelFrame(this.layoutFrame);
    this.typingTimer = this.idleTimer = this.stateTimer = this.layoutFrame = null;
    for (const u of this.unsubs.splice(0)) this.safely(u, undefined);
    this.safely(() => this.deps.overlay.detach(this.fieldId), undefined);
    this.safely(() => this.adapter.dispose(), undefined);
  }

  // ---------------------------------------------------------------------------------------------
  // Text changes
  // ---------------------------------------------------------------------------------------------

  /** Adapter change callback (also used by endOwnEdit to sync). */
  onChange(text: string, inputType: string | null): void {
    if (this.disposed || text === this.model.text) return;
    const oldText = this.model.text;
    const own = this.own !== null;
    const change = this.model.update(text, own ? { provenance: 'jammarly' } : inputType);
    if (!change) return;
    const rebase = this.store.rebase(oldText, text, own ? { ids: this.own!.ids } : undefined);
    if (!own) {
      this.sweep = null; // the user took over: stop applying rounds
      for (const s of rebase.dropped) {
        this.feedback.invalidated(s, oldText);
        this.feedback.trackDropped(s, oldText);
      }
      this.feedback.onTextChanged(this.model);
      if (inputType === 'historyUndo' || inputType === 'historyRedo') this.apply.reconcileNativeUndo();
      this.ui.setTyping(true);
      this.ui.closeCard();
      if (this.typingTimer !== null) this.timers.clearTimeout(this.typingTimer);
      this.typingTimer = this.timers.setTimeout(() => {
        this.typingTimer = null;
        if (!this.disposed) this.ui.setTyping(false);
      }, TYPING_IDLE_MS);
      if (this.idleTimer !== null) this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = this.timers.setTimeout(() => {
        this.idleTimer = null;
        if (!this.disposed) this.feedback.onIdle(this.model.text);
      }, FEEDBACK_IDLE_MS);
      this.scheduler.noteChange({ inserted: text.slice(change.region.start, change.region.newEnd), inputType, own: false });
    }
    this.pruneLog();
    this.refresh();
  }

  private beginOwnEdit(_edits: Edit[], ids: string[]): void {
    this.own = { ids: new Set(ids), startVersion: this.model.version };
  }

  private endOwnEdit(text: string): void {
    const own = this.own;
    if (text !== this.model.text) this.onChange(text, null);
    this.own = null;
    if (own && this.model.version !== own.startVersion) this.scheduler.afterApply();
  }

  // ---------------------------------------------------------------------------------------------
  // Rules and passes
  // ---------------------------------------------------------------------------------------------

  private runLocalRules(): void {
    if (this.disposed) return;
    const text = this.model.text;
    if (!this.isEnabled() || text.length === 0) {
      this.store.setRules([]);
      this.refresh();
      return;
    }
    const c = this.deps.getConfig();
    const masked = [...stripUrlsAndCode(text).masked, ...this.protectedRanges()];
    const hits = runRules(text, {
      dialect: c.dialect,
      context: this.context(),
      formality: c.goals.formality,
      protectedTerms: [...c.dictionary, ...this.localDictionary],
      styleDecisions: c.styleDecisions,
      masked,
      typing: this.focused,
      mutedRules: [...c.mutedRules, ...this.localMuted],
    });
    this.store.setRules(hitsToSuggestions(hits, { blocks: splitParagraphs(text), promptVersion: PROMPT_VERSION }));
    this.refresh();
  }

  /** Whether a Claude pass may be requested at all (consent, engine, host, text, input word floor). */
  canCheck(): boolean {
    const c = this.deps.getConfig();
    if (!this.isEnabled() || !c.consented || !c.engineReady) return false;
    const text = this.model.text;
    if (text.trim().length === 0) return false;
    if (this.kind === 'input' && countWords(text) < INPUT_MIN_WORDS) return false;
    return true;
  }

  private requestPass(pass: RequestedPass, trigger: PassTrigger): void {
    if (this.disposed) return;
    if (trigger === 'blur' || (trigger === 'idle' && pass === passFor('deep', this.deps.getConfig().mode))) this.sampleVoice();
    if (!this.canCheck()) return;
    const text = this.model.text;
    const blocks = splitParagraphs(text);
    const force = trigger === 'manual';
    let dirty: string[] | 'all';
    if (force || !this.everChecked) dirty = 'all';
    else {
      dirty = blocks.filter((b) => b.text.trim().length > 0 && passRank(this.checked.get(b.hash)) < PASS_RANK[pass]).map((b) => b.hash);
      if (dirty.length === 0) return;
    }
    const textHash = hashText(text);
    const current = this.inflight[pass];
    if (current && current.textHash === textHash && !force) return;
    const request: CheckRequest = {
      fieldId: this.fieldId,
      version: this.model.version,
      text,
      blocks,
      dirtyBlockHashes: dirty,
      pass,
      host: this.deps.host,
      context: this.context(),
      fieldKind: this.kind,
      protectedRanges: this.protectedRanges(),
    };
    this.inflight[pass] = { version: this.model.version, textHash, request };
    this.deps.setOutstanding(this.outstandingKey(pass), true);
    this.deps.send({ type: 'check', request });
    this.refresh();
  }

  private handleResult(result: CheckResult): void {
    if (result.version > this.model.version) return;
    const pass = result.pass === 'rules' ? undefined : result.pass;
    const entry = pass ? this.inflight[pass] : undefined;
    const isCurrent = pass !== undefined && entry !== undefined && entry.version === result.version;
    if (isCurrent && pass) {
      delete this.inflight[pass];
      this.deps.setOutstanding(this.outstandingKey(pass), false);
    }
    this.deepScheduled = false;
    if (result.usage) this.usage = result.usage;
    // A failed or cancelled sweep re-check ends the sweep with what it has applied so far.
    if (result.error && isCurrent && this.sweep && pass === this.sweep.pass) this.finishSweep();
    if (result.error) {
      if (result.error.code === 'cancelled') {
        if (isCurrent && pass && entry && result.error.retryable && hashText(this.model.text) === entry.textHash) {
          this.inflight[pass] = entry;
          this.deps.setOutstanding(this.outstandingKey(pass), true);
          this.deps.send({ type: 'check', request: entry.request });
        }
        this.refresh();
        return;
      }
      if (entry && !isCurrent) {
        this.refresh();
        return;
      }
      if (result.error.code === 'rate-limit' && result.error.retryable && isCurrent && pass && entry) this.scheduleRateLimitRetry(pass, entry, result.error.retryAfterMs);
      this.lastError = result.error;
      this.refresh();
      return;
    }
    this.lastError = undefined;
    if (pass) delete this.rateLimitRetries[pass];
    for (const b of result.blocks) {
      const prev = this.checked.get(b.hash);
      if (prev === undefined || PASS_RANK[b.pass] > PASS_RANK[prev]) this.checked.set(b.hash, b.pass);
    }
    let suggestions = result.suggestions;
    if (result.version !== this.model.version) {
      const changes = this.model.changesSince(result.version);
      if (!changes) {
        this.pruneLog();
        this.refresh();
        return;
      }
      for (const c of changes) {
        const from = this.model.snapshot(c.fromVersion);
        const to = this.model.snapshot(c.toVersion);
        if (from === undefined || to === undefined) {
          suggestions = [];
          break;
        }
        suggestions = rebaseSuggestions(suggestions, from, to);
      }
    }
    this.store.replaceLlm(suggestions);
    this.everChecked = true;
    if (result.tone) this.toneValue = result.tone;
    this.pruneLog();
    this.refresh();
    if (isCurrent && this.sweep && pass === this.sweep.pass) void this.continueSweep();
  }

  private cancelInflight(): void {
    const passes = this.inflightPasses;
    if (passes.length === 0) return;
    for (const p of passes) this.deps.setOutstanding(this.outstandingKey(p), false);
    this.inflight = {};
    this.deps.send({ type: 'cancel', fieldId: this.fieldId });
  }

  private outstandingKey(pass: RequestedPass): string {
    return `${this.fieldId}:${pass}`;
  }

  private pruneLog(): void {
    let oldest = this.model.version;
    for (const p of this.inflightPasses) {
      const e = this.inflight[p];
      if (e && e.version < oldest) oldest = e.version;
    }
    const tx = this.apply.oldestNeededVersion;
    if (tx !== null && tx < oldest) oldest = tx;
    const fb = this.feedback.oldestNeededVersion;
    if (fb !== null && fb < oldest) oldest = fb;
    this.model.prune(oldest);
  }

  private sampleVoice(): void {
    if (this.disposed || !this.deps.getConfig().consented) return;
    const text = this.model.text;
    if (text.length === 0) return;
    this.feedback.sampleVoice(text, this.model, [...stripUrlsAndCode(text).masked, ...this.protectedRanges()]);
  }

  // ---------------------------------------------------------------------------------------------
  // Focus, layout, UI
  // ---------------------------------------------------------------------------------------------

  private onFocusChange(focused: boolean): void {
    if (this.disposed || this.focused === focused) return;
    this.focused = focused;
    if (!focused) {
      this.scheduler.blur();
      this.scheduler.runRulesNow();
      this.feedback.onIdle(this.model.text);
      this.feedback.flush();
    } else this.scheduler.runRulesNow();
    this.scheduleFieldState();
  }

  private onLayout(): void {
    if (this.disposed || this.layoutFrame !== null) return;
    this.layoutFrame = this.timers.requestFrame(() => {
      this.layoutFrame = null;
      if (this.disposed) return;
      this.ui.updateRects(this.underlineItems());
      this.ui.setFieldBox(this.safely(() => this.adapter.getBox(), new DOMRect()));
    });
  }

  private refresh(): void {
    if (this.disposed) return;
    const enabled = this.isEnabled();
    this.ui.setUnderlines(enabled ? this.underlineItems() : []);
    this.ui.setStatus(this.status(), this.store.counts(), this.checkedBy(), this.status() === 'error' ? this.lastError : undefined);
    this.ui.setTone(enabled ? this.toneValue : undefined, this.model.text.length);
    this.ui.setFieldBox(this.safely(() => this.adapter.getBox(), new DOMRect()));
    this.scheduleFieldState();
  }

  private underlineItems(): UnderlineItem[] {
    return this.store.all.map((suggestion) => ({ suggestion, rects: this.rects(suggestion.highlight) }));
  }

  private rects(range: TextRange): DOMRect[] {
    return this.safely(() => this.adapter.getRangeRects(range), []);
  }

  private scheduleFieldState(): void {
    if (this.disposed || this.stateTimer !== null) return;
    this.stateTimer = this.timers.setTimeout(() => {
      this.stateTimer = null;
      if (this.disposed) return;
      this.deps.send({ type: 'field-state', state: this.fieldState() });
    }, FIELD_STATE_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------------------------
  // Config-derived values
  // ---------------------------------------------------------------------------------------------

  private filters(): StoreFilters {
    const c = this.deps.getConfig();
    return {
      mutedRules: new Set([...c.mutedRules, ...this.localMuted]),
      categories: c.categories,
      dictionary: new Set([...c.dictionary, ...this.localDictionary].map((w) => w.toLowerCase())),
    };
  }

  private schedulerConfig(): SchedulerConfig {
    const c = this.deps.getConfig();
    return {
      mode: c.mode,
      fastPassIdleMs: Math.max(0, Math.round(c.fastPassIdleMs * (this.profile.fastPassMultiplier || 1))),
      deepPassIdleMs: Math.max(0, Math.round(c.deepPassIdleMs * (this.profile.deepPassMultiplier || 1))),
    };
  }

  private snippetsAllowed(): boolean {
    const c = this.deps.getConfig();
    if (!c.consented) return false;
    return shouldStoreSnippet({
      storeSnippets: c.storeSnippets,
      host: this.deps.host,
      privateSites: [],
      fieldKind: this.kind,
      inputType: this.element.getAttribute('type') ?? undefined,
      autocomplete: this.element.getAttribute('autocomplete') ?? undefined,
    });
  }

  private computeDocKey(): string {
    const c = this.deps.getConfig();
    return computeDocKey(c.userSalt, this.deps.origin, fieldPath(this.element), this.safely(() => this.adapter.getDocHint(), ''));
  }

  private protectedRanges(): TextRange[] {
    return this.safely(() => this.adapter.getProtectedRanges(), []);
  }

  private safeText(): string {
    return this.safely(() => this.adapter.getText(), '');
  }

  private safely<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }
}
