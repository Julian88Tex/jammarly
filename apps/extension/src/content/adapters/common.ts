/**
 * Shared machinery for the field adapters: text normalization, timing primitives, the three-window verification
 * (immediately, next animation frame, +150 ms) and the ladder driver that guarantees a rung is never re-run and
 * that a second rung is only attempted when the field is back at its pre-edit text (ARCHITECTURE §3.4).
 */
import type { BatchEditOutcome, Edit, EditOutcome, EditRung } from '@jammarly/shared/types';

/** Lexical reverts foreign mutations up to ~100 ms later and Slate throttles selection; the last window sits past both. */
export const VERIFY_DELAY_MS = 150;

const NBSP_RE = / /g;
const ZERO_WIDTH_RE = /[​‌‍﻿]/g;

export function normalizeNbsp(s: string): string {
  return s.replace(NBSP_RE, ' ');
}

export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH_RE, '');
}

/** Equal modulo NBSP ↔ space and editor-inserted zero-width anchors. */
export function textsEquivalent(a: string, b: string): boolean {
  return a === b || stripZeroWidth(normalizeNbsp(a)) === stripZeroWidth(normalizeNbsp(b));
}

export function now(): number {
  return Date.now();
}

/** Resolves on the next animation frame (or ~16 ms when requestAnimationFrame is unavailable). Looked up at call time so tests can stub it. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const raf = (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame;
    if (typeof raf === 'function') raf(() => resolve());
    else setTimeout(resolve, 16);
  });
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** The text an edit should produce when applied to `text`. */
export function expectedTextAfter(text: string, edit: Edit): string {
  return text.slice(0, edit.range.start) + edit.replacement + text.slice(edit.range.end);
}

/** The edit's range is inside `text` and still holds `original` (NBSP-normalized). */
export function editMatchesText(text: string, edit: Edit): boolean {
  const { start, end } = edit.range;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return false;
  return normalizeNbsp(text.slice(start, end)) === normalizeNbsp(edit.original);
}

/** `replacement` now sits at `range.start` (NBSP-normalized). */
export function replacementInPlace(text: string, edit: Edit): boolean {
  const { start } = edit.range;
  return normalizeNbsp(text.slice(start, start + edit.replacement.length)) === normalizeNbsp(edit.replacement);
}

export type VerifyResult = 'applied' | 'no-effect' | 'reverted';

/**
 * Verify a write immediately, at the next animation frame and at +150 ms from `startedAt`.
 * - A write that never shows up is 'no-effect'; one that showed up and vanished is 'reverted'.
 * - Resolves early (after the frame check) when the text is not there, unless `patient`: when an editor claimed
 *   the event (preventDefault) it may commit asynchronously, so the full window is waited before giving up.
 */
export async function verifyWindows(check: () => boolean, startedAt: number = now(), patient = false): Promise<VerifyResult> {
  const immediate = check();
  await nextFrame();
  const atFrame = check();
  if (!atFrame && !patient) return immediate ? 'reverted' : 'no-effect';
  const remaining = VERIFY_DELAY_MS - (now() - startedAt);
  if (remaining > 0) await delay(remaining);
  if (check()) return 'applied';
  return immediate || atFrame ? 'reverted' : 'no-effect';
}

/**
 * What a rung's `run` reports: `false` when the rung is unavailable here (nothing was written, try the next one),
 * 'performed' when Jammarly wrote (or asked the browser to write) synchronously, 'claimed' when the host editor
 * took the event over and may commit asynchronously (verification waits the full window).
 */
export type RunResult = false | 'performed' | 'claimed';

export interface RungAttempt {
  rung: EditRung;
  run: () => RunResult | Promise<RunResult>;
}

/**
 * Drive the ladder for one edit against `readText()`. Each rung runs at most once; after a rung that did not
 * stick, the text must equal the pre-edit snapshot or the attempt stops with 'mismatch' (a partial write or an
 * auto-conversion must never be followed by another write, which would duplicate text). 'reverted' is reported
 * when the last rung's write showed up and the host undid it, leaving the original text.
 */
export async function runLadder(edit: Edit, readText: () => string, rungs: readonly RungAttempt[]): Promise<EditOutcome> {
  const before = readText();
  if (!editMatchesText(before, edit)) return { status: 'mismatch', rung: null, text: before };
  const expected = expectedTextAfter(before, edit);
  const check = (): boolean => {
    const t = readText();
    return replacementInPlace(t, edit) && textsEquivalent(t, expected);
  };
  let lastRung: EditRung | null = null;
  let lastResult: VerifyResult | null = null;
  for (const attempt of rungs) {
    const startedAt = now();
    let ran: RunResult;
    try {
      ran = await attempt.run();
    } catch {
      ran = false;
    }
    if (!ran) continue;
    lastRung = attempt.rung;
    const result = await verifyWindows(check, startedAt, ran === 'claimed');
    lastResult = result;
    if (result === 'applied') return { status: 'applied', rung: attempt.rung, text: readText() };
    // Only a field that is back at its pre-edit text may receive another rung. Anything else (a partial write, an
    // auto-conversion by the host) is a mismatch and must never be followed by a second write.
    const after = readText();
    if (!textsEquivalent(after, before)) return { status: 'mismatch', rung: attempt.rung, text: after };
  }
  const text = readText();
  if (lastRung === null) return { status: 'unsupported', rung: null, text };
  return { status: lastResult === 'reverted' ? 'reverted' : 'unsupported', rung: lastRung, text };
}

/** Rungs that leave one step on the host's native undo stack per edit. */
export const NATIVE_UNDO_RUNGS: ReadonlySet<EditRung> = new Set<EditRung>(['execCommand']);

/**
 * Apply edits right-to-left (descending start) so earlier offsets stay valid, verifying each through `applyOne`;
 * stop at the first edit that does not apply. Overlapping edits are skipped as 'mismatch' without aborting.
 * Edits after an abort are reported as skipped with the aborting edit's status.
 */
export async function applyEditsRightToLeft(edits: readonly Edit[], applyOne: (edit: Edit) => Promise<EditOutcome>, readText: () => string): Promise<BatchEditOutcome> {
  const ordered = [...edits].sort((a, b) => b.range.start - a.range.start || b.range.end - a.range.end);
  const applied: Edit[] = [];
  const skipped: BatchEditOutcome['skipped'] = [];
  let nativeUndoSteps = 0;
  let floor = Number.POSITIVE_INFINITY; // start of the last edit applied; the next edit must end at or before it
  for (let i = 0; i < ordered.length; i++) {
    const edit = ordered[i]!;
    if (edit.range.end > floor) {
      skipped.push({ edit, reason: 'mismatch' });
      continue;
    }
    const outcome = await applyOne(edit);
    if (outcome.status === 'applied') {
      applied.push(edit);
      floor = edit.range.start;
      if (outcome.rung && NATIVE_UNDO_RUNGS.has(outcome.rung)) nativeUndoSteps++;
      continue;
    }
    skipped.push({ edit, reason: outcome.status });
    for (const rest of ordered.slice(i + 1)) skipped.push({ edit: rest, reason: outcome.status });
    break;
  }
  return { applied, skipped, text: readText(), nativeUndoSteps };
}

export { deepActiveElement } from '../detect';

/** `clamp` for offsets. */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
