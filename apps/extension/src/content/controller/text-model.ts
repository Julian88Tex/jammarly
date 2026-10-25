/**
 * Per-field text model (ARCHITECTURE §3.2): the current plain text, a monotonic version, a log of DiffRegions keyed by
 * version (one `diffShift` per change) with the snapshot text of every retained version, and provenance ranges that
 * remember which characters were typed, pasted/dropped or written by Jammarly (§3.7: voice samples take only typed
 * sentences). Pure data; no DOM.
 */
import type { TextRange } from '@jammarly/shared/types';
import { diffShift, type DiffRegion } from '@jammarly/shared/text';

export type Provenance = 'typed' | 'pasted' | 'jammarly';

export interface ProvenanceRange extends TextRange {
  kind: Provenance;
}

export interface TextChange {
  fromVersion: number;
  toVersion: number;
  region: DiffRegion;
  provenance: Provenance;
  inputType: string | null;
}

/** A change source: the InputEvent inputType (null when unknown) or an explicit provenance (our own applies). */
export type ChangeSource = string | null | { provenance: Provenance };

const PASTE_LIKE: ReadonlySet<string> = new Set(['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop', 'insertFromYank']);

export function isPasteLike(inputType: string | null | undefined): boolean {
  return typeof inputType === 'string' && PASTE_LIKE.has(inputType);
}

export function provenanceForInputType(inputType: string | null): Provenance {
  return isPasteLike(inputType) ? 'pasted' : 'typed';
}

/** Shifts a range across one changed region; null when the range overlaps the region (same rule as rebaseSuggestions). */
export function shiftRangeThrough(range: TextRange, region: DiffRegion): TextRange | null {
  if (range.end <= region.start) return { start: range.start, end: range.end };
  if (range.start >= region.oldEnd) {
    const delta = region.newEnd - region.oldEnd;
    return { start: range.start + delta, end: range.end + delta };
  }
  return null;
}

/** Longest log kept when nothing prunes it (keystrokes between checks); older versions become un-rebaseable. */
export const DEFAULT_MAX_LOG = 400;

export class TextModel {
  private current: string;
  private ver = 0;
  private readonly log: TextChange[] = [];
  private readonly snapshots = new Map<number, string>();
  private prov: ProvenanceRange[] = [];
  private readonly maxLog: number;

  constructor(initialText = '', opts: { maxLog?: number } = {}) {
    this.current = initialText;
    this.maxLog = Math.max(1, opts.maxLog ?? DEFAULT_MAX_LOG);
    this.snapshots.set(0, initialText);
  }

  get text(): string {
    return this.current;
  }

  get version(): number {
    return this.ver;
  }

  /** Oldest version whose snapshot and every later region are still retained. */
  get oldestRetained(): number {
    const first = this.log[0];
    return first ? first.fromVersion : this.ver;
  }

  /** The retained change log, oldest first. */
  get changes(): readonly TextChange[] {
    return this.log;
  }

  /**
   * Records a new text. Returns null (and bumps nothing) when the text is unchanged. `source` is the InputEvent
   * inputType for user edits (paste-like types mark the inserted characters 'pasted') or an explicit provenance.
   */
  update(newText: string, source: ChangeSource = null): TextChange | null {
    const region = diffShift(this.current, newText);
    if (region === null) return null;
    const provenance = source !== null && typeof source === 'object' ? source.provenance : provenanceForInputType(source);
    const change: TextChange = {
      fromVersion: this.ver,
      toVersion: this.ver + 1,
      region,
      provenance,
      inputType: typeof source === 'string' ? source : null,
    };
    this.applyProvenance(region, provenance);
    this.current = newText;
    this.ver += 1;
    this.log.push(change);
    this.snapshots.set(this.ver, newText);
    if (this.log.length > this.maxLog) {
      const removed = this.log.splice(0, this.log.length - this.maxLog);
      for (const c of removed) this.snapshots.delete(c.fromVersion);
    }
    return change;
  }

  /** Text at `version`, when retained. */
  snapshot(version: number): string | undefined {
    return this.snapshots.get(version);
  }

  /** True when a result anchored to `version` can still be mapped onto the current text. */
  canRebaseFrom(version: number): boolean {
    if (!Number.isInteger(version) || version > this.ver) return false;
    if (version === this.ver) return true;
    return this.snapshots.has(version) && this.oldestRetained <= version;
  }

  /** Regions between `fromVersion` and the current version, in order; null when the log no longer reaches back. */
  regionsSince(fromVersion: number): DiffRegion[] | null {
    if (!this.canRebaseFrom(fromVersion)) return null;
    const out: DiffRegion[] = [];
    for (const c of this.log) if (c.fromVersion >= fromVersion) out.push(c.region);
    return out;
  }

  changesSince(fromVersion: number): TextChange[] | null {
    if (!this.canRebaseFrom(fromVersion)) return null;
    return this.log.filter((c) => c.fromVersion >= fromVersion);
  }

  /** Stepwise rebase of a range anchored at `fromVersion` onto the current text; null when any edit touched it. */
  shiftThrough(fromVersion: number, range: TextRange): TextRange | null {
    return this.shiftBetween(fromVersion, this.ver, range);
  }

  /** Stepwise rebase from one retained version to a later one. */
  shiftBetween(fromVersion: number, toVersion: number, range: TextRange): TextRange | null {
    if (toVersion < fromVersion || !this.canRebaseFrom(fromVersion) || toVersion > this.ver) return null;
    let r: TextRange = { start: range.start, end: range.end };
    for (const c of this.log) {
      if (c.fromVersion < fromVersion) continue;
      if (c.fromVersion >= toVersion) break;
      const shifted = shiftRangeThrough(r, c.region);
      if (shifted === null) return null;
      r = shifted;
    }
    return r;
  }

  /** Drops log entries and snapshots older than `oldestNeeded` (the oldest outstanding check or undoable transaction). */
  prune(oldestNeeded: number): void {
    const cutoff = Math.min(Math.max(0, Math.floor(oldestNeeded)), this.ver);
    let drop = 0;
    while (drop < this.log.length && this.log[drop]!.fromVersion < cutoff) drop++;
    if (drop > 0) this.log.splice(0, drop);
    for (const v of [...this.snapshots.keys()]) if (v < cutoff) this.snapshots.delete(v);
  }

  provenanceRanges(): readonly ProvenanceRange[] {
    return this.prov;
  }

  /** Every character of `range` was typed (never pasted, dropped, pre-existing or written by Jammarly). */
  isTyped(range: TextRange): boolean {
    if (range.end <= range.start) return false;
    let pos = range.start;
    for (const r of this.prov) {
      if (r.end <= pos) continue;
      if (r.start > pos) return false;
      if (r.kind !== 'typed') return false;
      pos = r.end;
      if (pos >= range.end) return true;
    }
    return pos >= range.end;
  }

  /** Provenance of one character position, or null for pre-existing text. */
  provenanceAt(offset: number): Provenance | null {
    for (const r of this.prov) {
      if (offset < r.start) return null;
      if (offset < r.end) return r.kind;
    }
    return null;
  }

  private applyProvenance(region: DiffRegion, kind: Provenance): void {
    const delta = region.newEnd - region.oldEnd;
    const next: ProvenanceRange[] = [];
    for (const r of this.prov) {
      if (r.end <= region.start) {
        next.push(r);
        continue;
      }
      if (r.start >= region.oldEnd) {
        next.push({ start: r.start + delta, end: r.end + delta, kind: r.kind });
        continue;
      }
      const leftEnd = Math.min(r.end, region.start);
      if (leftEnd > r.start) next.push({ start: r.start, end: leftEnd, kind: r.kind });
      const rightStart = Math.max(r.start, region.oldEnd);
      if (r.end > rightStart) next.push({ start: rightStart + delta, end: r.end + delta, kind: r.kind });
    }
    if (region.newEnd > region.start) next.push({ start: region.start, end: region.newEnd, kind });
    next.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: ProvenanceRange[] = [];
    for (const r of next) {
      const last = merged[merged.length - 1];
      if (last && last.kind === r.kind && last.end >= r.start) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    this.prov = merged;
  }
}
