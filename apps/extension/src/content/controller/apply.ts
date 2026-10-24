/**
 * Accept / Accept-all / Undo / Revert transactions (ARCHITECTURE §3.4). Every apply re-validates `original` against
 * the current text and the protected ranges, waits for an IME composition to end, writes through the adapter ladder
 * and records an ApplyTransaction whose edits carry post-apply ranges. Undo is inverse edits: each stored edit is
 * mapped through the diff regions logged since the transaction, re-validated (`text.slice(range) === replacement`)
 * and the inverses are applied right-to-left; textarea/input may fall back to a whole-text restore when nothing else
 * changed since.
 */
import type { AcceptAllScope, ApplyReport, ApplyTransaction, Edit, Suggestion, TextRange } from '@jammarly/shared/types';
import { applyEdits, tidyEdit } from '@jammarly/shared/text';
import type { FieldAdapter } from '../field-adapter';
import type { SuggestionStore } from './store';
import { selectAcceptAll } from './store';
import type { TextModel } from './text-model';
import { rangesIntersect, realTimers, sameText, type Timers } from './util';

export const MAX_TRANSACTIONS = 20;
export const COMPOSITION_SETTLE_MS = 50;
export const COMPOSITION_WAIT_MAX_MS = 5000;

export interface ApplyHost {
  fieldId: string;
  adapter: FieldAdapter;
  model: TextModel;
  store: SuggestionStore;
  /** Called right before the adapter writes: the session tags the coming text changes as Jammarly's own. */
  beginOwnEdit(edits: Edit[], ids: string[]): void;
  /** Called once the adapter settled, with its final text: the session syncs the model and clears the tag. */
  endOwnEdit(text: string): void;
  now(): number;
  newId(): string;
  timers?: Timers;
}

export type AcceptStatus = 'applied' | 'missing' | 'mismatch' | 'protected' | 'composing' | 'failed';

export interface AcceptResult {
  status: AcceptStatus;
  suggestion?: Suggestion;
  /** The replacement actually written (an alternative when one was chosen). */
  replacement?: string;
  transaction?: ApplyTransaction;
}

export interface AcceptAllResult {
  applied: Suggestion[];
  skipped: Suggestion[];
  pendingRewrites: Suggestion[];
  transaction: ApplyTransaction | null;
  report: ApplyReport | null;
}

export interface UndoResult {
  status: 'undone' | 'partial' | 'nothing' | 'failed';
  revertedIds: string[];
  transaction: ApplyTransaction | null;
}

interface TransactionMeta {
  /** Model version right after the apply (the version the post-apply ranges are anchored to). */
  version: number;
  /** Text before the apply (textarea/input whole-text fallback). */
  before: string;
  /** The applied suggestions, aligned with transaction.appliedIds. */
  suggestions: Suggestion[];
}

export function editForSuggestion(s: Suggestion, alternativeIndex?: number): Edit {
  const alt = alternativeIndex !== undefined ? s.alternatives[alternativeIndex] : undefined;
  return { range: { start: s.range.start, end: s.range.end }, original: s.original, replacement: alt ?? s.replacement };
}

export function validateEdit(text: string, edit: Edit, protectedRanges: readonly TextRange[]): 'ok' | 'mismatch' | 'protected' {
  const { start, end } = edit.range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > text.length) return 'mismatch';
  if (!sameText(text.slice(start, end), edit.original)) return 'mismatch';
  for (const p of protectedRanges) if (rangesIntersect(p, edit.range) || (start === end && start > p.start && start < p.end)) return 'protected';
  return 'ok';
}

/**
 * Post-apply ranges of edits applied against one snapshot: sort ascending, accumulate the length deltas of the edits
 * before each one. Result is aligned with `applied` (same order as given).
 */
export function postApplyEdits(applied: readonly Edit[]): Edit[] {
  const order = applied.map((e, i) => ({ e, i })).sort((a, b) => a.e.range.start - b.e.range.start || a.e.range.end - b.e.range.end || a.i - b.i);
  const out = new Array<Edit>(applied.length);
  let delta = 0;
  for (const { e, i } of order) {
    const start = e.range.start + delta;
    out[i] = { range: { start, end: start + e.replacement.length }, original: e.original, replacement: e.replacement };
    delta += e.replacement.length - (e.range.end - e.range.start);
  }
  return out;
}

export function sameEdit(a: Edit, b: Edit): boolean {
  return a.range.start === b.range.start && a.range.end === b.range.end && a.replacement === b.replacement;
}

/** Resolves after `compositionend` (+ settle) on the field, or after the maximum wait. */
export function waitForCompositionEnd(adapter: FieldAdapter, timers: Timers = realTimers, settleMs = COMPOSITION_SETTLE_MS, maxMs = COMPOSITION_WAIT_MAX_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let settle: unknown = null;
    const finish = (): void => {
      if (done) return;
      done = true;
      timers.clearTimeout(limit);
      if (settle !== null) timers.clearTimeout(settle);
      adapter.element.removeEventListener('compositionend', onEnd, true);
      resolve();
    };
    const onEnd = (): void => {
      if (settle !== null) timers.clearTimeout(settle);
      settle = timers.setTimeout(finish, settleMs);
    };
    const limit = timers.setTimeout(finish, maxMs);
    adapter.element.addEventListener('compositionend', onEnd, true);
    if (!adapter.isComposing()) onEnd();
  });
}

export class ApplyEngine {
  private readonly transactions: ApplyTransaction[] = [];
  private readonly meta = new Map<string, TransactionMeta>();

  constructor(private readonly host: ApplyHost) {}

  /** Newest first, at most MAX_TRANSACTIONS. */
  get history(): ApplyTransaction[] {
    return this.transactions.map((tx) => ({ ...tx, edits: tx.edits.map((e) => ({ ...e, range: { ...e.range } })), items: [...tx.items], appliedIds: [...tx.appliedIds], revertedIds: [...tx.revertedIds] }));
  }

  /** Transactions that still have something to undo. */
  get undoAvailable(): number {
    return this.transactions.filter((tx) => tx.appliedIds.some((id) => !tx.revertedIds.includes(id))).length;
  }

  /** Oldest version an undoable transaction is anchored to (for TextModel.prune). */
  get oldestNeededVersion(): number | null {
    let oldest: number | null = null;
    for (const tx of this.transactions) {
      if (!tx.appliedIds.some((id) => !tx.revertedIds.includes(id))) continue;
      const m = this.meta.get(tx.id);
      if (m && (oldest === null || m.version < oldest)) oldest = m.version;
    }
    return oldest;
  }

  transaction(id: string): ApplyTransaction | undefined {
    return this.transactions.find((tx) => tx.id === id);
  }

  async accept(suggestionId: string, alternativeIndex?: number): Promise<AcceptResult> {
    const { adapter, model, store } = this.host;
    let s = store.get(suggestionId);
    if (!s) return { status: 'missing' };
    if (adapter.isComposing()) {
      await waitForCompositionEnd(adapter, this.host.timers);
      if (adapter.isComposing()) return { status: 'composing', suggestion: s };
      s = store.get(suggestionId);
      if (!s) return { status: 'missing' };
    }
    const edit = tidyEdit(model.text, editForSuggestion(s, alternativeIndex));
    const check = validateEdit(model.text, edit, adapter.getProtectedRanges());
    if (check !== 'ok') return { status: check, suggestion: s };
    if (edit.replacement === edit.original) {
      // The text already has what this fix would add (another fix put the comma there).
      store.remove([s.id]);
      return { status: 'mismatch', suggestion: s };
    }
    const before = model.text;
    const expected = applyEdits(before, [edit]).text;
    this.host.beginOwnEdit([edit], [s.id]);
    let outcome;
    try {
      outcome = await adapter.applyEdit(edit);
    } catch {
      outcome = { status: 'unsupported' as const, rung: null, text: safeText(adapter, before) };
    }
    this.host.endOwnEdit(outcome.text);
    if (outcome.status === 'composing') return { status: 'composing', suggestion: s };
    if (outcome.status !== 'applied' || !sameText(outcome.text, expected)) return { status: 'failed', suggestion: s };
    const post = postApplyEdits([edit])[0]!;
    const tx: ApplyTransaction = {
      id: this.host.newId(),
      fieldId: this.host.fieldId,
      at: new Date(this.host.now()).toISOString(),
      edits: [post],
      items: [{ id: s.id, title: s.title, category: s.category, original: s.original, replacement: edit.replacement }],
      appliedIds: [s.id],
      revertedIds: [],
    };
    this.push(tx, { version: model.version, before, suggestions: [s] });
    store.remove([s.id]);
    store.recordApplied([edit]);
    return { status: 'applied', suggestion: s, replacement: edit.replacement, transaction: tx };
  }

  async acceptAll(scope: AcceptAllScope): Promise<AcceptAllResult> {
    const { adapter, model, store } = this.host;
    const selection = selectAcceptAll(store.all, scope);
    const skipped: Suggestion[] = [...selection.excluded];
    const empty = (): AcceptAllResult => ({ applied: [], skipped, pendingRewrites: selection.pendingRewrites, transaction: null, report: null });
    if (selection.selected.length === 0) return empty();
    if (adapter.isComposing()) {
      await waitForCompositionEnd(adapter, this.host.timers);
      if (adapter.isComposing()) {
        skipped.push(...selection.selected);
        return empty();
      }
    }
    const protectedRanges = adapter.getProtectedRanges();
    const valid: { s: Suggestion; edit: Edit }[] = [];
    for (const s of selection.selected) {
      const current = store.get(s.id) ?? s;
      const edit = tidyEdit(model.text, editForSuggestion(current));
      if (validateEdit(model.text, edit, protectedRanges) === 'ok' && edit.replacement !== edit.original) valid.push({ s: current, edit });
      else skipped.push(current);
    }
    if (valid.length === 0) return empty();
    const before = model.text;
    const edits = valid.map((v) => v.edit).sort((a, b) => b.range.start - a.range.start);
    this.host.beginOwnEdit(edits, valid.map((v) => v.s.id));
    let outcome;
    try {
      outcome = await adapter.applyEdits(edits);
    } catch {
      outcome = { applied: [] as Edit[], skipped: edits.map((edit) => ({ edit, reason: 'unsupported' as const })), text: safeText(adapter, before), nativeUndoSteps: 0 };
    }
    this.host.endOwnEdit(outcome.text);
    const appliedPairs = valid.filter((v) => outcome.applied.some((e) => sameEdit(e, v.edit)));
    for (const v of valid) if (!appliedPairs.includes(v)) skipped.push(v.s);
    if (appliedPairs.length === 0) return empty();
    const posts = postApplyEdits(appliedPairs.map((p) => p.edit));
    const tx: ApplyTransaction = {
      id: this.host.newId(),
      fieldId: this.host.fieldId,
      at: new Date(this.host.now()).toISOString(),
      edits: posts,
      items: appliedPairs.map((p) => ({ id: p.s.id, title: p.s.title, category: p.s.category, original: p.s.original, replacement: p.edit.replacement })),
      appliedIds: appliedPairs.map((p) => p.s.id),
      revertedIds: [],
    };
    this.push(tx, { version: model.version, before, suggestions: appliedPairs.map((p) => p.s) });
    store.remove(tx.appliedIds);
    store.recordApplied(appliedPairs.map((p) => p.edit));
    const report: ApplyReport = {
      fieldId: this.host.fieldId,
      appliedIds: [...tx.appliedIds],
      skippedIds: skipped.map((s) => s.id),
      pendingRewriteIds: selection.pendingRewrites.map((s) => s.id),
      transactionId: tx.id,
    };
    return { applied: appliedPairs.map((p) => p.s), skipped, pendingRewrites: selection.pendingRewrites, transaction: tx, report };
  }

  /** Undo one transaction (default: the newest with something left to undo). */
  async undo(transactionId?: string): Promise<UndoResult> {
    const tx = transactionId ? this.transaction(transactionId) : this.transactions.find((t) => t.appliedIds.some((id) => !t.revertedIds.includes(id)));
    if (!tx) return { status: 'nothing', revertedIds: [], transaction: null };
    const indices = tx.appliedIds.map((_, i) => i).filter((i) => !tx.revertedIds.includes(tx.appliedIds[i]!));
    if (indices.length === 0) return { status: 'nothing', revertedIds: [], transaction: tx };
    return this.undoIndices(tx, indices);
  }

  /** Per-item revert from the panel's "Recently applied" list. */
  async revert(suggestionId: string): Promise<UndoResult> {
    const tx = this.transactions.find((t) => t.appliedIds.includes(suggestionId) && !t.revertedIds.includes(suggestionId));
    if (!tx) return { status: 'nothing', revertedIds: [], transaction: null };
    return this.undoIndices(tx, [tx.appliedIds.indexOf(suggestionId)]);
  }

  /**
   * After a native undo/redo (`inputType` historyUndo/historyRedo): every applied edit whose replacement is no longer
   * at its mapped range counts as reverted. Returns the ids newly marked.
   */
  reconcileNativeUndo(): string[] {
    const { model } = this.host;
    const marked: string[] = [];
    for (const tx of this.transactions) {
      const m = this.meta.get(tx.id);
      if (!m) continue;
      tx.appliedIds.forEach((id, i) => {
        if (tx.revertedIds.includes(id)) return;
        const e = tx.edits[i];
        if (!e) return;
        const mapped = model.shiftThrough(m.version, e.range);
        if (mapped && sameText(model.text.slice(mapped.start, mapped.end), e.replacement)) return;
        tx.revertedIds.push(id);
        marked.push(id);
      });
    }
    return marked;
  }

  private async undoIndices(tx: ApplyTransaction, indices: number[]): Promise<UndoResult> {
    const { adapter, model, store } = this.host;
    const m = this.meta.get(tx.id);
    if (!m) return { status: 'failed', revertedIds: [], transaction: tx };
    const inverses: { i: number; edit: Edit }[] = [];
    const snapshot = model.snapshot(m.version);
    for (const i of indices) {
      const e = tx.edits[i];
      if (!e) continue;
      const mapped = model.shiftThrough(m.version, e.range);
      if (!mapped) continue;
      if (!sameText(model.text.slice(mapped.start, mapped.end), e.replacement)) continue;
      if (snapshot !== undefined && wordExtended(snapshot, e.range, model.text, mapped)) continue;
      inverses.push({ i, edit: { range: mapped, original: e.replacement, replacement: e.original } });
    }
    const allIndices = tx.appliedIds.map((_, i) => i).filter((i) => !tx.revertedIds.includes(tx.appliedIds[i]!));
    const wholeFallbackAllowed =
      (adapter.kind === 'textarea' || adapter.kind === 'input') && model.version === m.version && indices.length === allIndices.length && indices.length === tx.appliedIds.length;
    if (inverses.length === 0) {
      if (wholeFallbackAllowed) return this.restoreWhole(tx, m);
      return { status: 'failed', revertedIds: [], transaction: tx };
    }
    if (adapter.isComposing()) await waitForCompositionEnd(adapter, this.host.timers);
    inverses.sort((a, b) => b.edit.range.start - a.edit.range.start);
    const ids = inverses.map((inv) => tx.appliedIds[inv.i]!);
    this.host.beginOwnEdit(inverses.map((inv) => inv.edit), ids);
    let outcome;
    try {
      outcome = await adapter.applyEdits(inverses.map((inv) => inv.edit));
    } catch {
      outcome = { applied: [] as Edit[], skipped: [], text: safeText(adapter, model.text), nativeUndoSteps: 0 };
    }
    this.host.endOwnEdit(outcome.text);
    const done = inverses.filter((inv) => outcome.applied.some((a) => sameEdit(a, inv.edit)));
    if (done.length === 0) {
      if (wholeFallbackAllowed && model.version === m.version) return this.restoreWhole(tx, m);
      return { status: 'failed', revertedIds: [], transaction: tx };
    }
    const reverted: string[] = [];
    const posts = postApplyEdits(done.map((inv) => inv.edit));
    done.forEach((inv, k) => {
      const id = tx.appliedIds[inv.i]!;
      tx.revertedIds.push(id);
      reverted.push(id);
      const s = m.suggestions[inv.i];
      const post = posts[k];
      if (s && post) store.restore(s, { start: post.range.start, end: post.range.start + s.original.length }, model.text);
    });
    return { status: done.length === indices.length ? 'undone' : 'partial', revertedIds: reverted, transaction: tx };
  }

  private async restoreWhole(tx: ApplyTransaction, m: TransactionMeta): Promise<UndoResult> {
    const { adapter, model, store } = this.host;
    const whole: Edit = { range: { start: 0, end: model.text.length }, original: model.text, replacement: m.before };
    this.host.beginOwnEdit([whole], [...tx.appliedIds]);
    let outcome;
    try {
      outcome = await adapter.applyEdit(whole);
    } catch {
      outcome = { status: 'unsupported' as const, rung: null, text: safeText(adapter, model.text) };
    }
    this.host.endOwnEdit(outcome.text);
    if (outcome.status !== 'applied' || !sameText(outcome.text, m.before)) return { status: 'failed', revertedIds: [], transaction: tx };
    const reverted: string[] = [];
    tx.appliedIds.forEach((id, i) => {
      if (tx.revertedIds.includes(id)) return;
      tx.revertedIds.push(id);
      reverted.push(id);
      const s = m.suggestions[i];
      if (s) store.restore(s, s.range, model.text);
    });
    return { status: 'undone', revertedIds: reverted, transaction: tx };
  }

  private push(tx: ApplyTransaction, meta: TransactionMeta): void {
    this.transactions.unshift(tx);
    this.meta.set(tx.id, meta);
    while (this.transactions.length > MAX_TRANSACTIONS) {
      const dropped = this.transactions.pop();
      if (dropped) this.meta.delete(dropped.id);
    }
  }
}

function safeText(adapter: FieldAdapter, fallback: string): string {
  try {
    return adapter.getText();
  } catch {
    return fallback;
  }
}

const WORD_CHAR_RE = /^[\p{L}\p{N}']$/u;

/** True when the user typed a letter right before or after the applied span since the apply ("the" -> "thee"). */
function wordExtended(snapshot: string, at: TextRange, text: string, mapped: TextRange): boolean {
  const beforeThen = snapshot.slice(at.start - 1, at.start);
  const afterThen = snapshot.slice(at.end, at.end + 1);
  const beforeNow = text.slice(mapped.start - 1, mapped.start);
  const afterNow = text.slice(mapped.end, mapped.end + 1);
  if (beforeNow !== beforeThen && WORD_CHAR_RE.test(beforeNow)) return true;
  if (afterNow !== afterThen && WORD_CHAR_RE.test(afterNow)) return true;
  return false;
}
