/**
 * Side panel controller: owns the store, the worker port and every user action. Rendering lives in ./view.
 *
 * Message flow: the panel sends `hello` on each (re)connect, then renders from WorkerToPanel messages. Field actions
 * travel as `panel-action`s (the worker routes them to the content script); the scratch document is applied locally.
 */
import type {
  AcceptAllScope,
  CheckResult,
  DismissReason,
  FieldState,
  PanelAction,
  PanelToWorker,
  Suggestion,
  SuggestionCategory,
  WorkerToPanel,
  WritingGoals,
} from '@jammarly/shared/types';
import { computeScore } from '@jammarly/shared/text';
import { chromeApi, openOptionsPage } from '../common/env';
import { isTypingTarget, preserveFocus } from '../common/dom';
import { coerceCheckError, coerceFieldState, coerceSettings, normalizeGoals, sanitizeSuggestions } from '../common/guards';
import { connectPanelPort, type PanelPort } from '../common/port';
import { pick, request } from '../common/rpc';
import { createStore, type Store } from '../common/store';
import { applyTheme, watchTheme } from '../common/theme';
import { createToastHost, type ToastHandle } from '../common/ui';
import {
  applyGroupLocally,
  applyLocally,
  buildScratchRequest,
  copyText,
  removeLocally,
  validateAgainstText,
} from './scratch';
import {
  ALL_CATEGORIES_ON,
  SCRATCH_FIELD_ID,
  SCRATCH_HISTORY_LIMIT,
  currentField,
  dictionaryWord,
  initialScratch,
  initialState,
  isScratchView,
  removeField,
  replaceFields,
  tierSet,
  upsertField,
  type AcceptAllGroup,
  type GroupKey,
  type PanelState,
} from './state';
import { renderPanel, type PanelView } from './view';

export interface PanelActions {
  selectField(fieldId: string | null): void;
  toggleCategory(category: SuggestionCategory): void;
  toggleGroup(key: GroupKey): void;
  openGoals(): void;
  updateGoalsDraft(patch: Partial<WritingGoals>, scope?: 'host' | 'global'): void;
  saveGoals(): void;
  closeDialog(): void;
  previewEnter(group: AcceptAllGroup): void;
  previewLeave(): void;
  previewPin(group: AcceptAllGroup): void;
  previewChoose(group: AcceptAllGroup): void;
  previewToggle(id: string): void;
  previewSelectAll(on: boolean): void;
  closePreview(): void;
  acceptAll(group: AcceptAllGroup, ids?: string[]): void;
  accept(id: string, alternativeIndex?: number): void;
  dismiss(id: string, reason?: DismissReason): void;
  focusSuggestion(id: string): void;
  addToDictionary(id: string): void;
  muteRule(id: string, scope: 'host' | 'global'): void;
  revert(id: string): void;
  undo(transactionId?: string): void;
  requestDismissAll(category: SuggestionCategory): void;
  confirmDismissAll(): void;
  cancelDismissAll(): void;
  recheck(): void;
  openMenu(kind: 'dismiss' | 'more', id: string): void;
  closeMenu(): void;
  toggleExpanded(id: string): void;
  setFocused(id: string | null): void;
  moveFocus(delta: 1 | -1): void;
  scratchSetText(text: string): void;
  scratchCheck(): void;
  scratchUndo(): void;
  scratchCopy(): Promise<boolean>;
  scratchClear(): void;
  openSettings(): void;
  refreshUsage(): Promise<void>;
}

export interface SidePanelApp {
  root: HTMLElement;
  store: Store<PanelState>;
  actions: PanelActions;
  port: PanelPort;
  toast: ToastHandle;
  /** Resolves once the window id lookup, port connect and first usage fetch finished. */
  ready: Promise<void>;
  dispose(): void;
}

export interface MountOptions {
  /** Interval for refreshing today's cost; 0 disables. */
  usageRefreshMs?: number;
  now?: () => string;
  /** How long a scratch check may stay silent (no progress, no result) before it is reported as not finished. */
  scratchTimeoutMs?: number;
}

/** A deep pass on a long paste can legitimately take a while; progress messages reset this clock. */
export const SCRATCH_CHECK_TIMEOUT_MS = 60_000;
/** A field action is sent once per suggestion until the worker reports back (or this long has passed). */
export const PENDING_ACTION_TTL_MS = 3000;

export function mountSidePanel(root: HTMLElement, opts: MountOptions = {}): SidePanelApp {
  const store = createStore<PanelState>(initialState());
  const toast = createToastHost();
  const now = opts.now ?? (() => new Date().toISOString());
  const scratchTimeoutMs = opts.scratchTimeoutMs ?? SCRATCH_CHECK_TIMEOUT_MS;
  let disposed = false;
  let windowId: number | undefined;
  const persistent: PanelView = { scratchTextarea: null, toast };
  /** "<fieldId>\n<action>\n<suggestionId>" -> Date.now() when that action was sent and no field update has arrived since. */
  const pendingActions = new Map<string, number>();
  let scratchTimer: ReturnType<typeof setTimeout> | null = null;

  function clearPending(fieldId?: string): void {
    if (fieldId === undefined) {
      pendingActions.clear();
      return;
    }
    for (const key of Array.from(pendingActions.keys())) if (key.startsWith(`${fieldId}\n`)) pendingActions.delete(key);
  }

  /** True (and records the action) when this action is not already pending for the suggestion; false drops a duplicate. */
  function claimAction(fieldId: string, action: 'accept' | 'dismiss', suggestionId: string): boolean {
    const key = `${fieldId}\n${action}\n${suggestionId}`;
    const sentAt = pendingActions.get(key);
    const t = Date.now();
    if (sentAt !== undefined && t - sentAt < PENDING_ACTION_TTL_MS) return false;
    pendingActions.set(key, t);
    return true;
  }

  function stopScratchTimer(): void {
    if (scratchTimer) clearTimeout(scratchTimer);
    scratchTimer = null;
  }

  function armScratchTimer(version: number): void {
    stopScratchTimer();
    if (scratchTimeoutMs <= 0) return;
    scratchTimer = setTimeout(() => {
      scratchTimer = null;
      store.update((s) => {
        if (!s.scratch.checking || s.scratch.version !== version) return s;
        return { ...s, scratch: { ...s.scratch, checking: false, checkedOnce: true, error: { code: 'unknown', message: "The check didn't finish. Try again.", retryable: true } } };
      });
    }, scratchTimeoutMs);
  }

  // -------------------------------------------------------------------------
  // Port
  // -------------------------------------------------------------------------
  const port = connectPanelPort({
    onOpen: (p) => p.send({ type: 'hello', role: 'sidepanel', windowId }),
  });
  port.onStatus((status) => store.update((s) => ({ ...s, portStatus: status })));
  port.onMessage((msg) => handleMessage(msg));
  // connect() runs synchronously inside connectPanelPort, before the status handler above was attached.
  store.update((s) => (s.portStatus === port.status ? s : { ...s, portStatus: port.status }));

  function handleMessage(msg: WorkerToPanel): void {
    switch (msg.type) {
      case 'fields': {
        const fields: FieldState[] = [];
        if (Array.isArray(msg.fields)) {
          for (const raw of msg.fields) {
            const f = coerceFieldState(raw);
            if (f) fields.push(f);
          }
        }
        clearPending();
        store.update((s) => replaceFields(s, fields));
        break;
      }
      case 'field-state': {
        const f = coerceFieldState(msg.state);
        if (!f) break;
        clearPending(f.fieldId);
        store.update((s) => upsertField(s, f));
        break;
      }
      case 'field-removed':
        if (typeof msg.fieldId !== 'string') break;
        clearPending(msg.fieldId);
        store.update((s) => removeField(s, msg.fieldId));
        break;
      case 'check-progress':
        if (typeof msg.fieldId !== 'string') break;
        store.update((s) => {
          if (msg.fieldId === SCRATCH_FIELD_ID) {
            if (!s.scratch.checking) return s;
            // The worker is alive and working on this version: give it the full window again.
            armScratchTimer(s.scratch.version);
            return s;
          }
          if (!s.fields[msg.fieldId]) return s;
          return { ...s, progress: { ...s.progress, [msg.fieldId]: { pass: msg.pass, stage: msg.stage } } };
        });
        break;
      case 'check-result':
        applyCheckResult(msg.result);
        void refreshUsage();
        break;
      case 'tone': {
        if (typeof msg.fieldId !== 'string' || !msg.tone || typeof msg.tone !== 'object' || !Array.isArray(msg.tone.labels)) break;
        const tone = { labels: msg.tone.labels.filter((l) => l && typeof l.label === 'string'), summary: typeof msg.tone.summary === 'string' ? msg.tone.summary : '' };
        store.update((s) => {
          if (msg.fieldId === SCRATCH_FIELD_ID) return { ...s, scratch: { ...s.scratch, tone } };
          const field = s.fields[msg.fieldId];
          if (!field) return s;
          return upsertField(s, { ...field, tone });
        });
        break;
      }
      case 'config': {
        const config = msg.config && typeof msg.config === 'object' ? { ...msg.config, goals: normalizeGoals(msg.config.goals) } : null;
        const sync = msg.sync && typeof msg.sync === 'object' && typeof msg.sync.status === 'string' ? msg.sync : null;
        store.update((s) => ({
          ...s,
          config,
          settings: coerceSettings(msg.settings),
          sync,
          categories: config?.categories && typeof config.categories === 'object' ? { ...ALL_CATEGORIES_ON, ...config.categories } : s.categories,
        }));
        break;
      }
    }
  }

  function applyCheckResult(result: CheckResult): void {
    if (!result || typeof result !== 'object' || typeof result.fieldId !== 'string') return;
    const error = coerceCheckError(result.error);
    const incoming = Array.isArray(result.suggestions) ? sanitizeSuggestions(result.suggestions) : null;
    if (result.fieldId !== SCRATCH_FIELD_ID) clearPending(result.fieldId);
    store.update((s) => {
      if (result.fieldId === SCRATCH_FIELD_ID) {
        if (typeof result.version === 'number' && result.version < s.scratch.version) return s;
        stopScratchTimer();
        const suggestions = validateAgainstText(s.scratch.text, incoming ?? []);
        return {
          ...s,
          scratch: {
            ...s.scratch,
            checking: false,
            checkedOnce: true,
            suggestions,
            error: error ?? null,
            score: result.score && typeof result.score.overall === 'number' ? result.score : computeScore(s.scratch.text, suggestions),
            tone: result.tone && Array.isArray(result.tone.labels) ? result.tone : s.scratch.tone,
          },
        };
      }
      const progress = { ...s.progress };
      delete progress[result.fieldId];
      const field = s.fields[result.fieldId];
      if (!field) return { ...s, progress };
      if (typeof result.version === 'number' && result.version < field.version) return { ...s, progress };
      const suggestions = incoming ?? field.suggestions;
      const next: FieldState = {
        ...field,
        suggestions,
        error,
        score: result.score && typeof result.score.overall === 'number' ? result.score : field.score,
        tone: result.tone && Array.isArray(result.tone.labels) ? result.tone : field.tone,
        checkedBy: result.pass === 'fast' || result.pass === 'deep' || result.pass === 'rules' ? result.pass : field.checkedBy,
        status: error ? 'error' : suggestions.length > 0 ? 'suggestions' : 'clean',
      };
      return upsertField({ ...s, progress }, next);
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  function sendAction(action: PanelAction): void {
    port.send(actionMessage(action));
  }

  function findSuggestion(id: string): { suggestion: Suggestion; fieldId: string; scratch: boolean } | null {
    const s = store.get();
    if (isScratchView(s)) {
      const found = s.scratch.suggestions.find((x) => x.id === id);
      return found ? { suggestion: found, fieldId: SCRATCH_FIELD_ID, scratch: true } : null;
    }
    const field = currentField(s);
    if (!field) return null;
    const found = field.suggestions.find((x) => x.id === id);
    return found ? { suggestion: found, fieldId: field.fieldId, scratch: false } : null;
  }

  async function refreshUsage(): Promise<void> {
    const res = await request({ type: 'get-usage' });
    if (disposed) return;
    const usage = pick(res, 'usage');
    if (usage && usage.usage && typeof usage.usage === 'object') store.update((s) => ({ ...s, usage: usage.usage }));
  }

  function pushScratchHistory(s: PanelState): PanelState['scratch'] {
    const history = [...s.scratch.history, { text: s.scratch.text, suggestions: s.scratch.suggestions, applied: s.scratch.applied }];
    if (history.length > SCRATCH_HISTORY_LIMIT) history.splice(0, history.length - SCRATCH_HISTORY_LIMIT);
    return { ...s.scratch, history };
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  const actions: PanelActions = {
    selectField(fieldId) {
      store.update((s) => ({ ...s, selectedFieldId: fieldId, ui: { ...s.ui, menu: null, preview: null, confirmDismissAll: null, focusedId: null } }));
    },
    toggleCategory(category) {
      const next = { ...store.get().categories, [category]: !store.get().categories[category] };
      store.update((s) => ({ ...s, categories: next }));
      port.send({ type: 'set-categories', categories: next });
    },
    toggleGroup(key) {
      store.update((s) => ({ ...s, collapsed: { ...s.collapsed, [key]: !s.collapsed[key] } }));
    },
    openGoals() {
      const s = store.get();
      const goals: WritingGoals = normalizeGoals(s.config?.goals);
      store.update((st) => ({ ...st, ui: { ...st.ui, dialog: { kind: 'goals', goals, scope: 'global' }, menu: null, preview: null } }));
    },
    updateGoalsDraft(patch, scope) {
      store.update((s) => {
        if (!s.ui.dialog) return s;
        return { ...s, ui: { ...s.ui, dialog: { ...s.ui.dialog, goals: { ...s.ui.dialog.goals, ...patch }, scope: scope ?? s.ui.dialog.scope } } };
      });
    },
    saveGoals() {
      const s = store.get();
      const dialog = s.ui.dialog;
      if (!dialog) return;
      const field = currentField(s);
      const host = field?.host ?? s.config?.host;
      const scope = dialog.scope === 'host' && host ? 'host' : 'global';
      port.send({ type: 'set-goals', goals: dialog.goals, scope, host: scope === 'host' ? host : undefined });
      if (field) sendAction({ type: 'recheck', fieldId: field.fieldId });
      store.update((st) => ({ ...st, ui: { ...st.ui, dialog: null }, config: st.config ? { ...st.config, goals: dialog.goals } : st.config }));
      toast.show('Goals updated');
    },
    closeDialog() {
      store.update((s) => (s.ui.dialog ? { ...s, ui: { ...s.ui, dialog: null } } : s));
    },
    previewEnter(group) {
      store.update((s) => {
        if (s.ui.preview?.pinned) return s;
        if (s.ui.preview && s.ui.preview.group === group && !s.ui.preview.choose) return s;
        return { ...s, ui: { ...s.ui, preview: { group, choose: false, selected: [], pinned: false } } };
      });
    },
    previewLeave() {
      store.update((s) => (s.ui.preview && !s.ui.preview.pinned ? { ...s, ui: { ...s.ui, preview: null } } : s));
    },
    previewPin(group) {
      store.update((s) => {
        if (s.ui.preview?.pinned && s.ui.preview.group === group) return { ...s, ui: { ...s.ui, preview: null } };
        return { ...s, ui: { ...s.ui, preview: { group, choose: false, selected: [], pinned: true } } };
      });
    },
    previewChoose(group) {
      const s = store.get();
      const suggestions = isScratchView(s) ? s.scratch.suggestions : currentField(s)?.suggestions ?? [];
      const ids = tierSet(suggestions, group).map((x) => x.id);
      store.update((st) => ({ ...st, ui: { ...st.ui, preview: { group, choose: true, selected: ids, pinned: true } } }));
    },
    previewToggle(id) {
      store.update((s) => {
        if (!s.ui.preview) return s;
        const selected = s.ui.preview.selected.includes(id) ? s.ui.preview.selected.filter((x) => x !== id) : [...s.ui.preview.selected, id];
        return { ...s, ui: { ...s.ui, preview: { ...s.ui.preview, selected } } };
      });
    },
    previewSelectAll(on) {
      const s = store.get();
      if (!s.ui.preview) return;
      const suggestions = isScratchView(s) ? s.scratch.suggestions : currentField(s)?.suggestions ?? [];
      const ids = on ? tierSet(suggestions, s.ui.preview.group).map((x) => x.id) : [];
      store.update((st) => (st.ui.preview ? { ...st, ui: { ...st.ui, preview: { ...st.ui.preview, selected: ids } } } : st));
    },
    closePreview() {
      store.update((s) => (s.ui.preview ? { ...s, ui: { ...s.ui, preview: null } } : s));
    },
    acceptAll(group, ids) {
      const s = store.get();
      if (isScratchView(s)) {
        const result = applyGroupLocally(s.scratch.text, s.scratch.suggestions, group, ids);
        if (result.appliedIds.length === 0) {
          toast.show('Nothing to apply');
          return;
        }
        store.update((st) => {
          const scratch = pushScratchHistory(st);
          return {
            ...st,
            scratch: { ...scratch, text: result.text, suggestions: result.suggestions, applied: [...result.applied, ...scratch.applied], score: computeScore(result.text, result.suggestions) },
            ui: { ...st.ui, preview: null },
          };
        });
        syncScratchTextarea();
        toast.show(`Applied ${result.appliedIds.length} ${result.appliedIds.length === 1 ? 'change' : 'changes'}`, { actionLabel: 'Undo', onAction: () => actions.scratchUndo(), durationMs: 8000 });
        return;
      }
      const field = currentField(s);
      if (!field) return;
      const scope: AcceptAllScope = ids ? { group, suggestionIds: ids } : { group };
      sendAction({ type: 'accept-all', fieldId: field.fieldId, scope });
      store.update((st) => ({ ...st, ui: { ...st.ui, preview: null } }));
    },
    accept(id, alternativeIndex) {
      const found = findSuggestion(id);
      if (!found || found.suggestion.kind === 'flag') return;
      if (found.scratch) {
        const s = store.get();
        const result = applyLocally(s.scratch.text, s.scratch.suggestions, [id], alternativeIndex, now);
        if (result.appliedIds.length === 0) {
          // The span no longer matches; drop the stale suggestion.
          store.update((st) => ({ ...st, scratch: { ...st.scratch, suggestions: removeLocally(st.scratch.suggestions, id) } }));
          toast.show("That text changed, so the suggestion no longer applies", { tone: 'error' });
          return;
        }
        store.update((st) => {
          const scratch = pushScratchHistory(st);
          return {
            ...st,
            scratch: { ...scratch, text: result.text, suggestions: result.suggestions, applied: [...result.applied, ...scratch.applied], score: computeScore(result.text, result.suggestions) },
            ui: { ...st.ui, menu: null },
          };
        });
        syncScratchTextarea();
        toast.show('Applied', { actionLabel: 'Undo', onAction: () => actions.scratchUndo(), durationMs: 8000 });
        return;
      }
      // One action per suggestion until the worker reports the field again: Enter held down, a double click or a
      // second press before the content script answers must not queue duplicate applies.
      if (!claimAction(found.fieldId, 'accept', id)) return;
      sendAction({ type: 'accept', fieldId: found.fieldId, suggestionId: id, alternativeIndex });
      store.update((st) => ({ ...st, ui: { ...st.ui, menu: null } }));
    },
    dismiss(id, reason) {
      const found = findSuggestion(id);
      if (!found) return;
      if (found.scratch) {
        port.send({ type: 'dismiss', fieldId: SCRATCH_FIELD_ID, suggestionId: id, fingerprint: found.suggestion.fingerprint, rule: found.suggestion.rule, docKey: SCRATCH_FIELD_ID, reason });
        store.update((st) => ({ ...st, scratch: { ...st.scratch, suggestions: removeLocally(st.scratch.suggestions, id) }, ui: { ...st.ui, menu: null } }));
        return;
      }
      if (!claimAction(found.fieldId, 'dismiss', id)) return;
      sendAction({ type: 'dismiss', fieldId: found.fieldId, suggestionId: id, reason });
      store.update((st) => ({ ...st, ui: { ...st.ui, menu: null } }));
    },
    focusSuggestion(id) {
      const found = findSuggestion(id);
      if (!found) return;
      store.update((st) => ({ ...st, ui: { ...st.ui, focusedId: id } }));
      if (found.scratch) {
        const area = persistent.scratchTextarea;
        if (area) {
          try {
            area.focus({ preventScroll: true });
            area.setSelectionRange(found.suggestion.range.start, found.suggestion.range.end);
          } catch {
            // selection outside the textarea's range
          }
        }
        return;
      }
      sendAction({ type: 'focus', fieldId: found.fieldId, suggestionId: id });
    },
    addToDictionary(id) {
      const found = findSuggestion(id);
      if (!found) return;
      const word = dictionaryWord(found.suggestion);
      if (!word) return;
      port.send({ type: 'add-to-dictionary', word });
      if (found.scratch) {
        store.update((st) => ({ ...st, scratch: { ...st.scratch, suggestions: removeLocally(st.scratch.suggestions, id) }, ui: { ...st.ui, menu: null } }));
      } else {
        store.update((st) => ({ ...st, ui: { ...st.ui, menu: null } }));
      }
      toast.show(`Added "${word}" to your dictionary`);
    },
    muteRule(id, scope) {
      const found = findSuggestion(id);
      if (!found) return;
      const s = store.get();
      const host = found.scratch ? undefined : currentField(s)?.host;
      port.send({ type: 'mute-rule', rule: found.suggestion.rule, scope: scope === 'host' && host ? 'host' : 'global', host: scope === 'host' ? host : undefined });
      if (found.scratch) {
        store.update((st) => ({ ...st, scratch: { ...st.scratch, suggestions: st.scratch.suggestions.filter((x) => x.rule !== found.suggestion.rule) }, ui: { ...st.ui, menu: null } }));
      } else {
        store.update((st) => ({ ...st, ui: { ...st.ui, menu: null } }));
      }
      toast.show(scope === 'host' && host ? `Turned off this rule on ${host}` : 'Turned off this rule everywhere');
    },
    revert(id) {
      const s = store.get();
      if (isScratchView(s)) {
        toast.show('Use Undo to revert changes in this text');
        return;
      }
      const field = currentField(s);
      if (!field) return;
      sendAction({ type: 'revert', fieldId: field.fieldId, suggestionId: id });
    },
    undo(transactionId) {
      const s = store.get();
      if (isScratchView(s)) {
        actions.scratchUndo();
        return;
      }
      const field = currentField(s);
      if (!field) return;
      sendAction({ type: 'undo', fieldId: field.fieldId, transactionId });
    },
    requestDismissAll(category) {
      store.update((s) => ({ ...s, ui: { ...s.ui, confirmDismissAll: category, menu: null } }));
    },
    confirmDismissAll() {
      const s = store.get();
      const category = s.ui.confirmDismissAll;
      if (!category) return;
      if (isScratchView(s)) {
        store.update((st) => ({ ...st, scratch: { ...st.scratch, suggestions: st.scratch.suggestions.filter((x) => x.category !== category) }, ui: { ...st.ui, confirmDismissAll: null } }));
        return;
      }
      const field = currentField(s);
      if (field) sendAction({ type: 'dismiss-all', fieldId: field.fieldId, category });
      store.update((st) => ({ ...st, ui: { ...st.ui, confirmDismissAll: null } }));
    },
    cancelDismissAll() {
      store.update((s) => (s.ui.confirmDismissAll ? { ...s, ui: { ...s.ui, confirmDismissAll: null } } : s));
    },
    recheck() {
      const s = store.get();
      if (isScratchView(s)) {
        actions.scratchCheck();
        return;
      }
      const field = currentField(s);
      if (field) sendAction({ type: 'recheck', fieldId: field.fieldId });
    },
    openMenu(kind, id) {
      store.update((s) => ({ ...s, ui: { ...s.ui, menu: s.ui.menu && s.ui.menu.kind === kind && s.ui.menu.suggestionId === id ? null : { kind, suggestionId: id }, preview: null } }));
    },
    closeMenu() {
      store.update((s) => (s.ui.menu ? { ...s, ui: { ...s.ui, menu: null } } : s));
    },
    toggleExpanded(id) {
      store.update((s) => ({ ...s, ui: { ...s.ui, expanded: s.ui.expanded.includes(id) ? s.ui.expanded.filter((x) => x !== id) : [...s.ui.expanded, id] } }));
    },
    setFocused(id) {
      store.update((s) => (s.ui.focusedId === id ? s : { ...s, ui: { ...s.ui, focusedId: id } }));
    },
    moveFocus(delta) {
      const cards = Array.from(root.querySelectorAll<HTMLElement>('.jm-card[data-suggestion-id]'));
      if (cards.length === 0) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('.jm-card[data-suggestion-id]') : null;
      const focusedId = store.get().ui.focusedId;
      let index = active ? cards.indexOf(active) : cards.findIndex((c) => c.dataset.suggestionId === focusedId);
      if (index < 0) index = delta > 0 ? -1 : cards.length;
      const next = cards[Math.max(0, Math.min(cards.length - 1, index + delta))];
      if (!next) return;
      next.focus();
      const id = next.dataset.suggestionId ?? null;
      actions.setFocused(id);
    },
    scratchSetText(text) {
      const s = store.get();
      if (s.scratch.text === text) return;
      const invalidated = s.scratch.suggestions.length > 0 ? validateAgainstText(text, s.scratch.suggestions) : s.scratch.suggestions;
      const next: PanelState = { ...s, scratch: { ...s.scratch, text, suggestions: invalidated } };
      const visibleChange = (s.scratch.text.trim().length > 0) !== (text.trim().length > 0) || invalidated.length !== s.scratch.suggestions.length;
      // Typing only moves text the textarea already shows; skip the full re-render unless buttons or cards change.
      if (visibleChange) store.set(next);
      else store.replace(next);
    },
    scratchCheck() {
      const s = store.get();
      const text = s.scratch.text;
      if (text.trim().length === 0) {
        toast.show('Paste or type some text first');
        return;
      }
      const version = s.scratch.version + 1;
      store.update((st) => ({ ...st, scratch: { ...st.scratch, version, checking: true, error: null }, selectedFieldId: st.fieldOrder.length > 0 ? SCRATCH_FIELD_ID : st.selectedFieldId }));
      armScratchTimer(version);
      port.send({ type: 'check', request: buildScratchRequest(text, version) });
    },
    scratchUndo() {
      const s = store.get();
      const previous = s.scratch.history[s.scratch.history.length - 1];
      if (!previous) return;
      store.update((st) => ({
        ...st,
        scratch: { ...st.scratch, text: previous.text, suggestions: previous.suggestions, applied: previous.applied, history: st.scratch.history.slice(0, -1), score: computeScore(previous.text, previous.suggestions) },
      }));
      syncScratchTextarea();
    },
    async scratchCopy() {
      const ok = await copyText(store.get().scratch.text, persistent.scratchTextarea);
      toast.show(ok ? 'Copied the corrected text' : "Couldn't copy. Select the text and press Ctrl+C.", { tone: ok ? 'success' : 'error' });
      return ok;
    },
    scratchClear() {
      store.update((s) => ({ ...s, scratch: initialScratch() }));
      syncScratchTextarea();
    },
    openSettings() {
      void openOptionsPage();
    },
    refreshUsage,
  };

  function syncScratchTextarea(): void {
    const area = persistent.scratchTextarea;
    if (area && area.value !== store.get().scratch.text) area.value = store.get().scratch.text;
  }

  // -------------------------------------------------------------------------
  // Rendering and global listeners
  // -------------------------------------------------------------------------
  const render = (): void => {
    if (disposed) return;
    preserveFocus(root, () => renderPanel(root, store.get(), actions, persistent));
  };
  const unsubscribe = store.subscribe(render);
  const themeOptions = (): { colorblind: boolean } => ({ colorblind: store.get().config?.colorblindMode === true });
  const stopTheme = watchTheme(document.documentElement, themeOptions);
  let lastColorblind = themeOptions().colorblind;
  store.subscribe(() => {
    const next = themeOptions().colorblind;
    if (next !== lastColorblind) {
      lastColorblind = next;
      applyTheme(document.documentElement, themeOptions());
    }
  });

  const onKeydown = (ev: KeyboardEvent): void => {
    const s = store.get();
    if (ev.key === 'Escape') {
      if (s.ui.menu || s.ui.preview || s.ui.dialog || s.ui.confirmDismissAll) {
        ev.preventDefault();
        store.update((st) => ({ ...st, ui: { ...st.ui, menu: null, preview: null, dialog: null, confirmDismissAll: null } }));
      }
      return;
    }
    if (isTypingTarget(ev.target)) return;
    if (s.ui.dialog) return;
    // A held key auto-repeats: navigation may repeat, accept/dismiss must fire once per physical press.
    if (ev.repeat && (ev.key === 'Enter' || ev.key === 'Backspace' || ev.key === 'Delete')) {
      ev.preventDefault();
      return;
    }
    const card = ev.target instanceof HTMLElement ? ev.target.closest<HTMLElement>('.jm-card[data-suggestion-id]') : null;
    const onCardItself = card !== null && ev.target === card;
    if (ev.key === 'j' || ev.key === 'ArrowDown') {
      if (ev.key === 'ArrowDown' && !card) return;
      ev.preventDefault();
      actions.moveFocus(1);
    } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
      if (ev.key === 'ArrowUp' && !card) return;
      ev.preventDefault();
      actions.moveFocus(-1);
    } else if (ev.key === 'Enter' && onCardItself && card) {
      ev.preventDefault();
      const id = card.dataset.suggestionId;
      if (id) actions.accept(id);
    } else if ((ev.key === 'Backspace' || ev.key === 'Delete') && onCardItself && card) {
      ev.preventDefault();
      const id = card.dataset.suggestionId;
      if (id) actions.dismiss(id);
    }
  };
  root.addEventListener('keydown', onKeydown);

  const onDocumentClick = (ev: MouseEvent): void => {
    const s = store.get();
    if (!s.ui.menu && !(s.ui.preview && s.ui.preview.pinned)) return;
    const target = ev.target instanceof Element ? ev.target : null;
    if (target?.closest('.jm-menu, .jm-menu-trigger, .jm-preview, .jm-accept-all')) return;
    store.update((st) => ({ ...st, ui: { ...st.ui, menu: null, preview: null } }));
  };
  document.addEventListener('click', onDocumentClick);

  let usageTimer: ReturnType<typeof setInterval> | null = null;
  const refreshMs = opts.usageRefreshMs ?? 60_000;
  if (refreshMs > 0) usageTimer = setInterval(() => void refreshUsage(), refreshMs);

  render();

  const ready = (async () => {
    try {
      const win = await Promise.resolve(chromeApi()?.windows?.getCurrent?.()).catch(() => undefined);
      if (win && typeof win.id === 'number') windowId = win.id;
    } catch {
      windowId = undefined;
    }
    // Re-send hello with the window id if the port opened before the lookup finished.
    if (port.status === 'open') port.send({ type: 'hello', role: 'sidepanel', windowId });
    await refreshUsage();
  })();

  return {
    root,
    store,
    actions,
    port,
    toast,
    ready,
    dispose() {
      disposed = true;
      unsubscribe();
      stopTheme();
      root.removeEventListener('keydown', onKeydown);
      document.removeEventListener('click', onDocumentClick);
      if (usageTimer) clearInterval(usageTimer);
      stopScratchTimer();
      port.close();
    },
  };
}

function actionMessage(action: PanelAction): Extract<PanelToWorker, { type: 'panel-action' }> {
  return { type: 'panel-action', action };
}
