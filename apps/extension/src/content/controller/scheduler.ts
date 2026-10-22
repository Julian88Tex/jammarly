/**
 * Per-field pass scheduling (ARCHITECTURE §3.3): local rules on every change, coalesced to one frame per 150 ms; a
 * fast pass after `fastPassIdleMs` idle or when the user ends a sentence; a deep pass after `deepPassIdleMs` idle, on
 * blur and on a paste of two or more sentences. Engine mode maps the intents: hybrid keeps both, quality sends 'deep'
 * for everything, economy sends 'fast' for everything. The session decides whether a request is actually needed
 * (dirty blocks, in-flight de-duplication); this class only owns the timing.
 */
import type { CheckPass, EngineMode } from '@jammarly/shared/types';
import { splitSentences } from '@jammarly/shared/text';
import { isPasteLike } from './text-model';
import { realTimers, type Timers } from './util';

export type RequestedPass = Exclude<CheckPass, 'rules'>;
export type PassTrigger = 'idle' | 'sentence-end' | 'paste' | 'blur' | 'attach' | 'manual' | 'after-apply';

export interface SchedulerConfig {
  mode: EngineMode;
  fastPassIdleMs: number;
  deepPassIdleMs: number;
}

export interface SchedulerHooks {
  runRules(): void;
  requestPass(pass: RequestedPass, trigger: PassTrigger): void;
}

export interface ChangeInfo {
  /** The characters the change inserted (empty for deletions). */
  inserted: string;
  inputType: string | null;
  /** True for text Jammarly wrote itself (accept, undo): no sentence/paste triggers, just the idle timers. */
  own: boolean;
}

export const RULES_COALESCE_MS = 150;
export const PASTE_SENTENCE_MIN = 2;

/** Which pass a fast/deep intent becomes under the engine mode. */
export function passFor(intent: RequestedPass, mode: EngineMode): RequestedPass {
  if (mode === 'quality') return 'deep';
  if (mode === 'economy') return 'fast';
  return intent;
}

const TRAILING_CLOSERS_RE = /[\s"'”’)\]}»]+$/u;
const TERMINATOR_RE = /[.!?…。！？]$/u;

/** True when the inserted text ends a sentence: a newline, or a terminator optionally followed by closers/space. */
export function endsSentence(inserted: string): boolean {
  if (inserted.length === 0) return false;
  if (/[\n\r]$/.test(inserted)) return true;
  const trimmed = inserted.replace(TRAILING_CLOSERS_RE, '');
  return TERMINATOR_RE.test(trimmed);
}

export function countSentences(text: string): number {
  return splitSentences(text).length;
}

export class Scheduler {
  private fastTimer: unknown = null;
  private deepTimer: unknown = null;
  private rulesTimer: unknown = null;
  private rulesFrame: unknown = null;
  private rulesPending = false;
  private lastRulesAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(
    private readonly hooks: SchedulerHooks,
    private config: SchedulerConfig,
    private readonly timers: Timers = realTimers,
  ) {}

  get mode(): EngineMode {
    return this.config.mode;
  }

  setConfig(config: SchedulerConfig): void {
    this.config = config;
  }

  /** A text change happened. */
  noteChange(info: ChangeInfo): void {
    if (this.disposed) return;
    this.scheduleRules();
    const fastPass = passFor('fast', this.config.mode);
    const deepPass = passFor('deep', this.config.mode);
    if (!info.own) {
      if (isPasteLike(info.inputType) && countSentences(info.inserted) >= PASTE_SENTENCE_MIN) {
        this.clearPassTimers();
        this.hooks.requestPass(deepPass, 'paste');
        return;
      }
      if (endsSentence(info.inserted)) {
        this.clearFast();
        this.hooks.requestPass(fastPass, 'sentence-end');
        this.armDeep(deepPass, fastPass);
        return;
      }
    }
    this.armTimers(fastPass, deepPass);
  }

  /** The field lost focus: deep pass now (economy: fast). */
  blur(): void {
    if (this.disposed) return;
    this.clearPassTimers();
    this.hooks.requestPass(passFor('deep', this.config.mode), 'blur');
  }

  /** A field with existing text was attached: check it right away, then let the deep pass follow after idle. */
  attach(hasText: boolean): void {
    if (this.disposed || !hasText) return;
    const fastPass = passFor('fast', this.config.mode);
    const deepPass = passFor('deep', this.config.mode);
    this.hooks.requestPass(fastPass, 'attach');
    this.armDeep(deepPass, fastPass);
  }

  /** "Check now" from the menu or panel. */
  checkNow(): void {
    if (this.disposed) return;
    this.clearPassTimers();
    this.hooks.requestPass(passFor('deep', this.config.mode), 'manual');
  }

  /** Jammarly changed the text (accept, undo): rules now, a fast re-check of the dirty blocks after idle. */
  afterApply(): void {
    if (this.disposed) return;
    this.scheduleRules();
    this.armTimers(passFor('fast', this.config.mode), passFor('deep', this.config.mode));
  }

  /** Coalesced rules run: at most one per RULES_COALESCE_MS, on the next frame/idle callback. */
  scheduleRules(): void {
    if (this.disposed || this.rulesPending) return;
    this.rulesPending = true;
    const run = (): void => {
      this.rulesPending = false;
      this.rulesFrame = null;
      this.rulesTimer = null;
      this.lastRulesAt = this.timers.now();
      this.hooks.runRules();
    };
    const elapsed = this.timers.now() - this.lastRulesAt;
    if (elapsed >= RULES_COALESCE_MS) this.rulesFrame = this.timers.requestFrame(run);
    else this.rulesTimer = this.timers.setTimeout(run, RULES_COALESCE_MS - elapsed);
  }

  /** Runs the rules synchronously (blur, config change) and cancels a pending coalesced run. */
  runRulesNow(): void {
    if (this.disposed) return;
    this.cancelRules();
    this.lastRulesAt = this.timers.now();
    this.hooks.runRules();
  }

  hasPendingPass(): boolean {
    return this.fastTimer !== null || this.deepTimer !== null;
  }

  cancel(): void {
    this.clearPassTimers();
    this.cancelRules();
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private armTimers(fastPass: RequestedPass, deepPass: RequestedPass): void {
    this.clearFast();
    this.fastTimer = this.timers.setTimeout(() => {
      this.fastTimer = null;
      this.hooks.requestPass(fastPass, 'idle');
    }, this.config.fastPassIdleMs);
    this.armDeep(deepPass, fastPass);
  }

  private armDeep(deepPass: RequestedPass, fastPass: RequestedPass): void {
    this.clearDeep();
    if (deepPass === fastPass) return;
    this.deepTimer = this.timers.setTimeout(() => {
      this.deepTimer = null;
      this.hooks.requestPass(deepPass, 'idle');
    }, this.config.deepPassIdleMs);
  }

  private clearFast(): void {
    if (this.fastTimer !== null) this.timers.clearTimeout(this.fastTimer);
    this.fastTimer = null;
  }

  private clearDeep(): void {
    if (this.deepTimer !== null) this.timers.clearTimeout(this.deepTimer);
    this.deepTimer = null;
  }

  private clearPassTimers(): void {
    this.clearFast();
    this.clearDeep();
  }

  private cancelRules(): void {
    if (this.rulesTimer !== null) this.timers.clearTimeout(this.rulesTimer);
    if (this.rulesFrame !== null) this.timers.cancelFrame(this.rulesFrame);
    this.rulesTimer = null;
    this.rulesFrame = null;
    this.rulesPending = false;
  }
}
