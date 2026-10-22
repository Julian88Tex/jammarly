/**
 * Engine orchestration (ARCHITECTURE §3.2/§3.3): cache-keyed block checks with pass supersession, sharding,
 * truncation retry, cancellation of stale requests, a global in-flight cap, budget and consent gates, stable ids,
 * learned-state and dismissal filtering, and the separate tone call.
 *
 * Request budget (low-tier API keys have small per-minute request limits, and short bursts trip them):
 * - one model call per pass for a normal email or document (up to MAX_BLOCKS_PER_CALL paragraphs and
 *   MAX_WORDS_PER_CALL words per call); longer fields are sharded;
 * - a fast and a deep pass for the same field and text never call the model at the same time: a deep pass waits
 *   for a fast call that is already running, and a fast pass that has not started yet yields to a pending deep
 *   pass and is then served from the deep pass's cache entries;
 * - the separate tone call is skipped when the main call already returned the tone of the whole text, and runs at
 *   most once per field per TONE_MIN_INTERVAL_MS unless the text changed substantially (see ./tone);
 * - every call waits out a shared cooldown after a 429 and a throttled call is retried RATE_LIMIT_RETRIES times;
 *   a deep pass that still fails is owed: the next successful fast pass for the same text runs it again.
 *
 * `check()` never throws for a user-visible failure: it emits a `check-result` carrying `error`. A failed pass still
 * carries the suggestions already cached for the field (so a 429 on the deep pass never blanks the fast pass's
 * suggestions in the side panel), and a pass where only some paragraphs failed emits the successful result first
 * and the error second, so the content script keeps every suggestion that did arrive. A request that was
 * superseded by a newer one for the same field and pass resolves silently (its result is simply dropped).
 */
import type {
  CachedSuggestion,
  CheckedBlock,
  CheckError,
  CheckRequest,
  CheckResult,
  DeviceSettings,
  EffectiveConfig,
  Paragraph,
  Suggestion,
  SuggestionCategory,
  TokenUsage,
  ToneAnalysis,
  ToneLabel,
} from '@jammarly/shared/types';
import { CATEGORIES, PASS_RANK } from '@jammarly/shared/types';
import type { ProfileDocument, VoiceContext } from '@jammarly/shared/profile';
import type { MaskedBlock } from '../shared-engine';
import {
  anchorSuggestions,
  applyLearnedState,
  blockIdFor,
  buildCheckMessages,
  computeScore,
  countWords,
  effortFor,
  hashText,
  hitsToSuggestions,
  lintVoiceProfile,
  orSetLive,
  parseEngineOutput,
  priceForModel,
  PROMPT_VERSION,
  renderVoiceBlock,
  runRules,
  SCHEMA_VERSION,
  stripUrlsAndCode,
} from '../shared-engine';
import type { LearnedStateView } from '../learning/fold';
import { modelsFor } from '../config';
import type { BlockCacheEntry, InflightRecord, UsageLedger } from '../storage';
import { budgetState, wouldExceedBudget } from '../usage';
import { abortError, isAbortError, Semaphore, sleep, stableJson } from '../util';
import type { BlockCache } from './cache';
import type { Provider } from './provider';
import { addUsage, checkError, isProviderError, ProviderError, toCheckError, ZERO_USAGE } from './provider';
import { toneSummaryFor, type ToneRunner } from './tone';

/** Paragraphs per model call: high enough that an email of any usual length is one call per pass. */
export const MAX_BLOCKS_PER_CALL = 40;
/** Words per model call: bounds the response size (a thorough pass writes ~100 output tokens per suggestion). */
export const MAX_WORDS_PER_CALL = 1200;
/** How many times a deep pass that failed (rate limit, network) is re-run for the same text. */
export const OWED_DEEP_ATTEMPTS = 1;
/** When an owed deep pass re-runs on its own (no later fast pass came first); never before the cooldown ends. */
export const OWED_DEEP_RETRY_MS = 20_000;
export const MAX_CONCURRENT_CALLS = 3;
/** Rate limits: every call waits out a shared cooldown, and a throttled call is retried this many times. */
export const RATE_LIMIT_RETRIES = 2;
export const RATE_LIMIT_MIN_WAIT_MS = 2_000;
export const RATE_LIMIT_MAX_WAIT_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000];
/** Planning figures for the budget pre-check (research 02 reviewer A5). */
export const EST_TOKENS_PER_WORD = 1.8;
/** A thorough pass writes ~100 tokens per suggestion; ~15 suggestions is a typical email paragraph set. */
export const EST_OUTPUT_TOKENS = 1500;

export type EngineMessage =
  | { type: 'check-progress'; fieldId: string; version: number; pass: CheckRequest['pass']; stage: 'queued' | 'sent' | 'streaming' | 'deep-scheduled' }
  | { type: 'check-result'; result: CheckResult }
  | { type: 'tone'; fieldId: string; version: number; tone: ToneAnalysis };

export interface EngineContext {
  host: string;
  /** Dismissal-memory key of the document the field belongs to ('' for scratch checks). */
  docKey: string;
  settings: DeviceSettings;
  profile: ProfileDocument;
  learned: LearnedStateView;
  config: EffectiveConfig;
  tabId?: number;
  frameId?: number;
  send(msg: EngineMessage): void;
}

export interface EngineDeps {
  providerFor(settings: DeviceSettings): Provider;
  cache: BlockCache;
  usage: { ledger(): UsageLedger; record(usage: TokenUsage, model: string): void };
  dismissed(docKey: string): Set<string>;
  applied(fieldId: string): Set<string>;
  keepalive?: { begin(): void; end(): void };
  inflight?: { add(rec: InflightRecord): void; remove(requestId: string): void };
  tone?: ToneRunner;
  now?: () => number;
  maxConcurrent?: number;
  /** Rate-limit handling (tests shrink the waits). */
  rateLimit?: { retries?: number; minWaitMs?: number; maxWaitMs?: number; backoffMs?: number[]; owedRetryMs?: number };
}

export interface Engine {
  check(request: CheckRequest, ctx: EngineContext): Promise<void>;
  cancel(fieldId: string): void;
  /** Model calls currently running or waiting for a permit. */
  readonly inFlight: number;
}

/** Voice-profile context for a writing context (research 09 §1.13); null for code. */
export function ctxToVoice(context: CheckRequest['context']): VoiceContext | null {
  switch (context) {
    case 'email':
    case 'chat':
    case 'social':
      return 'messages';
    case 'doc':
    case 'other':
      return 'documents';
    default:
      return null;
  }
}

export interface CacheKeyInput {
  model: string;
  pass: 'fast' | 'deep';
  config: EffectiveConfig;
  profile: ProfileDocument;
  context: CheckRequest['context'];
}

/** Stable JSON of the prompt configuration (ARCHITECTURE §3.2), hashed. */
export function computeCacheKey(input: CacheKeyInput): string {
  const { config, profile } = input;
  const voiceCtx = ctxToVoice(input.context);
  const voice = voiceCtx ? profile.voice.profiles[voiceCtx] : undefined;
  const categories = CATEGORIES.filter((c) => config.categories[c]);
  return hashText(
    stableJson({
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      model: input.model,
      // The pass decides thinking and output budget, so fast and deep results never share a key even when the
      // model and effort match (economy mode runs both passes on Haiku).
      pass: input.pass,
      effort: effortFor(input.pass),
      dialect: config.dialect,
      goals: config.goals,
      context: input.context,
      styleDecisions: config.styleDecisions,
      categories,
      customInstructions: hashText(profile.settings.customInstructions.value),
      protectedTerms: hashText([...config.dictionary].sort().join('\n')),
      voiceProfileVersion: voice?.version ?? 0,
      voiceStrength: profile.voice.settings.value.strength,
    }),
  );
}

/** Splits paragraphs into calls of <= 40 blocks and <= 1,200 words (a single oversized block travels alone). */
export function shardBlocks(paragraphs: readonly Paragraph[], maxBlocks = MAX_BLOCKS_PER_CALL, maxWords = MAX_WORDS_PER_CALL): Paragraph[][] {
  const out: Paragraph[][] = [];
  let current: Paragraph[] = [];
  let words = 0;
  for (const p of paragraphs) {
    const w = countWords(p.text);
    if (current.length > 0 && (current.length >= maxBlocks || words + w > maxWords)) {
      out.push(current);
      current = [];
      words = 0;
    }
    current.push(p);
    words += w;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function stableSuggestionId(fieldId: string, blockHash: string, fingerprint: string, ordinalInBlock: number): string {
  return hashText(`${fieldId}|${blockHash}|${fingerprint}|${ordinalInBlock}`);
}

/** Block-relative cache form of anchored suggestions for one paragraph. */
export function toCached(suggestions: readonly Suggestion[], paragraph: Paragraph): CachedSuggestion[] {
  const seen = new Map<string, number>();
  const out: CachedSuggestion[] = [];
  for (const s of suggestions) {
    const ordinal = seen.get(s.fingerprint) ?? 0;
    seen.set(s.fingerprint, ordinal + 1);
    const { id: _id, range, highlight, blockId: _b, conflictsWith: _c, stale: _s, learnedState: _l, ...rest } = s;
    out.push({
      ...rest,
      rel: { start: range.start - paragraph.start, end: range.end - paragraph.start },
      relHighlight: { start: highlight.start - paragraph.start, end: highlight.end - paragraph.start },
      ordinalInBlock: ordinal,
    });
  }
  return out;
}

/** Absolute suggestions for one paragraph from a cache entry; entries whose text no longer matches are dropped. */
export function serveCached(entry: BlockCacheEntry, paragraph: Paragraph, fieldId: string, text: string): Suggestion[] {
  const out: Suggestion[] = [];
  for (const c of entry.suggestions) {
    const range = { start: paragraph.start + c.rel.start, end: paragraph.start + c.rel.end };
    if (range.start < 0 || range.end > text.length || text.slice(range.start, range.end) !== c.original) continue;
    const highlight = { start: paragraph.start + c.relHighlight.start, end: paragraph.start + c.relHighlight.end };
    const { rel: _r, relHighlight: _h, ordinalInBlock, ...rest } = c;
    out.push({
      ...rest,
      id: stableSuggestionId(fieldId, paragraph.hash, c.fingerprint, ordinalInBlock),
      range,
      highlight,
      blockId: blockIdFor(paragraph.index),
      conflictsWith: [],
      stale: false,
      learnedState: 'active',
    });
  }
  return out;
}

const SPAN_KINDS = new Set(['replace', 'delete', 'insert']);

/** Links rewrites with the span edits inside them (ids are stable, so this is recomputed at serve time). */
export function linkConflicts(suggestions: Suggestion[]): Suggestion[] {
  const byBlock = new Map<string, Suggestion[]>();
  for (const s of suggestions) {
    const list = byBlock.get(s.blockId) ?? [];
    list.push(s);
    byBlock.set(s.blockId, list);
  }
  for (const list of byBlock.values()) {
    for (const rewrite of list) {
      if (rewrite.kind !== 'rewrite') continue;
      for (const span of list) {
        if (span === rewrite || !SPAN_KINDS.has(span.kind)) continue;
        if (span.range.start >= rewrite.range.start && span.range.end <= rewrite.range.end) {
          if (!rewrite.conflictsWith.includes(span.id)) rewrite.conflictsWith.push(span.id);
          if (!span.conflictsWith.includes(rewrite.id)) span.conflictsWith.push(rewrite.id);
        }
      }
    }
  }
  return suggestions;
}

interface ShardOutcome {
  suggestions: Suggestion[];
  blocks: MaskedBlock[];
  /** Hashes of blocks that could not be checked, with the reason. */
  failed: { hash: string; error: CheckError }[];
  usage: TokenUsage;
  model: string;
  tone: ToneLabel[];
  /** Number of provider calls made. */
  calls: number;
}

function emptyOutcome(model: string): ShardOutcome {
  return { suggestions: [], blocks: [], failed: [], usage: { ...ZERO_USAGE }, model, tone: [], calls: 0 };
}

function mergeOutcomes(a: ShardOutcome, b: ShardOutcome): ShardOutcome {
  return {
    suggestions: [...a.suggestions, ...b.suggestions],
    blocks: [...a.blocks, ...b.blocks],
    failed: [...a.failed, ...b.failed],
    usage: addUsage(a.usage, b.usage),
    model: a.calls > 0 ? a.model : b.model,
    tone: a.tone.length > 0 ? a.tone : b.tone,
    calls: a.calls + b.calls,
  };
}

export function createEngine(deps: EngineDeps): Engine {
  const now = deps.now ?? Date.now;
  const sem = new Semaphore(deps.maxConcurrent ?? MAX_CONCURRENT_CALLS);
  /** Set by a 429; every call (any field, any pass) waits until then so a burst does not keep hitting the limit. */
  let cooldownUntil = 0;
  const waitForCooldown = async (signal: AbortSignal): Promise<void> => {
    const wait = cooldownUntil - now();
    if (wait > 0) await sleep(wait, signal);
  };
  const rl = {
    retries: deps.rateLimit?.retries ?? RATE_LIMIT_RETRIES,
    minWaitMs: deps.rateLimit?.minWaitMs ?? RATE_LIMIT_MIN_WAIT_MS,
    maxWaitMs: deps.rateLimit?.maxWaitMs ?? RATE_LIMIT_MAX_WAIT_MS,
    backoffMs: deps.rateLimit?.backoffMs ?? RATE_LIMIT_BACKOFF_MS,
    owedRetryMs: deps.rateLimit?.owedRetryMs ?? OWED_DEEP_RETRY_MS,
  };
  const noteRateLimit = (e: ProviderError, attempt: number): number => {
    const suggested = e.retryAfterMs ?? rl.backoffMs[Math.min(attempt, rl.backoffMs.length - 1)] ?? rl.maxWaitMs;
    const wait = Math.min(rl.maxWaitMs, Math.max(rl.minWaitMs, suggested));
    cooldownUntil = Math.max(cooldownUntil, now() + wait);
    return wait;
  };
  /**
   * The newest request per field and pass. A newer request aborts an older one that has not sent its model call
   * yet (free); an older one whose call is already on the wire is not aborted (the request already counts against
   * the rate limit, and its result fills the block cache) but finishes silently, and the newer request waits for
   * it, so a field never has two calls of one pass in flight and a burst of edits collapses into one trailing call.
   */
  interface RunState {
    controller: AbortController;
    version: number;
    /** True once a model call of this run is on the wire. */
    sent: boolean;
    /** True once a newer request took over: the run finishes for the cache but emits nothing. */
    superseded: boolean;
    /** Settles when the run is over. */
    done: Promise<void>;
    /** An older run this one waits for before it starts. */
    after?: Promise<void>;
  }
  const inflight = new Map<string, RunState>();
  const byField = new Map<string, Set<AbortController>>();

  const track = (fieldId: string, controller: AbortController): void => {
    const set = byField.get(fieldId) ?? new Set();
    set.add(controller);
    byField.set(fieldId, set);
  };
  const untrack = (fieldId: string, controller: AbortController): void => {
    const set = byField.get(fieldId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) byField.delete(fieldId);
  };

  const errorResult = (request: CheckRequest, error: CheckError): CheckResult => ({
    fieldId: request.fieldId,
    version: request.version,
    pass: request.pass,
    suggestions: [],
    fromCache: false,
    blocks: [],
    error,
  });

  const finish = (request: CheckRequest, ctx: EngineContext, suggestions: Suggestion[]): Suggestion[] => {
    // Learned state (ARCHITECTURE §3.7): manual mutes from rules.muted ("<rule>" or "<rule>@<host>") hide a rule
    // outright; learner suppressions hide everything below the correctness floor; promoted correctness fixes reach
    // Tier A at confidence >= 0.70. Dismiss-reason overrides were already written to rules.muted by the port hub.
    const { visible } = applyLearnedState(suggestions, {
      ruleStates: ctx.learned.ruleStates,
      promoted: ctx.learned.promoted,
      manualOff: [],
      host: ctx.host,
      ctx: request.context,
      mutedRules: orSetLive(ctx.profile.rules.muted),
    });
    const dismissed = deps.dismissed(ctx.docKey);
    const applied = deps.applied(request.fieldId);
    const filtered = visible.filter((s) => !dismissed.has(s.fingerprint) && !applied.has(s.fingerprint));
    filtered.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || a.id.localeCompare(b.id));
    return linkConflicts(filtered.map((s) => ({ ...s, conflictsWith: [] })));
  };

  const localRules = (request: CheckRequest, ctx: EngineContext): CheckResult => {
    const masked = stripUrlsAndCode(request.text).masked;
    const hits = runRules(request.text, {
      dialect: ctx.config.dialect,
      context: request.context,
      formality: ctx.config.goals.formality,
      protectedTerms: ctx.config.dictionary,
      styleDecisions: ctx.config.styleDecisions,
      masked: [...masked, ...request.protectedRanges],
      typing: false,
      mutedRules: ctx.config.mutedRules,
    });
    const suggestions = finish(request, ctx, hitsToSuggestions(hits, { blocks: request.blocks, promptVersion: PROMPT_VERSION }));
    return {
      fieldId: request.fieldId,
      version: request.version,
      pass: 'rules',
      suggestions,
      score: computeScore(request.text, suggestions),
      fromCache: false,
      blocks: request.blocks.map((b) => ({ hash: b.hash, pass: 'rules' as const, fromCache: false })),
    };
  };

  /** Per-field passes that need model calls, so a fast and a deep pass for the same text never call at once. */
  interface Lane {
    textHash: string;
    /** True once the pass started its model calls (it no longer yields to a deep pass). */
    started: boolean;
    done: Promise<void>;
  }
  const lanes = new Map<string, { fast?: Lane; deep?: Lane }>();
  const openLane = (fieldId: string, pass: 'fast' | 'deep', textHash: string): { lane: Lane; close(): void } => {
    let resolve: () => void = () => undefined;
    const lane: Lane = { textHash, started: false, done: new Promise<void>((r) => (resolve = r)) };
    const entry = lanes.get(fieldId) ?? {};
    entry[pass] = lane;
    lanes.set(fieldId, entry);
    return {
      lane,
      close() {
        resolve();
        const cur = lanes.get(fieldId);
        if (cur && cur[pass] === lane) {
          delete cur[pass];
          if (!cur.fast && !cur.deep) lanes.delete(fieldId);
        }
      },
    };
  };
  const waitFor = (done: Promise<void>, signal: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = (): void => reject(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      void done.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  const waitLane = (lane: Lane, signal: AbortSignal): Promise<void> => waitFor(lane.done, signal);

  /**
   * Deep passes that failed (rate limit, network) per field. An owed deep pass re-runs after the next successful
   * fast pass for the same text, or on its own once the cooldown is over, at most OWED_DEEP_ATTEMPTS times, so a
   * throttled deep pass is never silently skipped until the user types again.
   */
  const owedDeep = new Map<string, { textHash: string; attempts: number }>();
  const owedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Hash of the newest text each field sent: an owed pass for text the user has since changed is pointless. */
  const latestText = new Map<string, string>();
  const clearOwed = (fieldId: string): void => {
    owedDeep.delete(fieldId);
    latestText.delete(fieldId);
    const t = owedTimers.get(fieldId);
    if (t !== undefined) clearTimeout(t);
    owedTimers.delete(fieldId);
  };
  const runOwed = (request: CheckRequest, ctx: EngineContext): void => {
    const t = owedTimers.get(request.fieldId);
    if (t !== undefined) clearTimeout(t);
    owedTimers.delete(request.fieldId);
    void check({ ...request, pass: 'deep', dirtyBlockHashes: 'all' }, ctx);
  };
  const scheduleOwed = (request: CheckRequest, ctx: EngineContext, textHash: string): void => {
    const prev = owedTimers.get(request.fieldId);
    if (prev !== undefined) clearTimeout(prev);
    const wait = Math.max(rl.owedRetryMs, cooldownUntil - now());
    owedTimers.set(
      request.fieldId,
      setTimeout(() => {
        owedTimers.delete(request.fieldId);
        const owed = owedDeep.get(request.fieldId);
        // Superseded (new text) or already re-running: nothing to do.
        if (!owed || owed.textHash !== textHash || latestText.get(request.fieldId) !== textHash || inflight.has(`${request.fieldId}|deep`)) return;
        runOwed(request, ctx);
      }, wait),
    );
  };

  async function run(request: CheckRequest, ctx: EngineContext, state: RunState): Promise<void> {
    const signal = state.controller.signal;
    const send = (msg: EngineMessage): void => {
      if (!signal.aborted && !state.superseded) ctx.send(msg);
    };
    const progress = (stage: 'queued' | 'sent' | 'streaming'): void => send({ type: 'check-progress', fieldId: request.fieldId, version: request.version, pass: request.pass, stage });

    if (request.pass === 'rules') {
      send({ type: 'check-result', result: localRules(request, ctx) });
      return;
    }
    const pass = request.pass;
    const { settings, profile, config } = ctx;
    if (!config.consented) {
      send({ type: 'check-result', result: errorResult(request, checkError('consent-required', false)) });
      return;
    }
    if (settings.provider === 'anthropic' && settings.apiKey.trim().length === 0) {
      send({ type: 'check-result', result: errorResult(request, checkError('no-api-key', false)) });
      return;
    }

    const budget = budgetState(settings, deps.usage.ledger(), now());
    const models = modelsFor(settings, profile, budget.exhausted);
    const model = pass === 'fast' ? models.fast : models.deep;
    const provider = deps.providerFor(settings);
    const cacheKey = computeCacheKey({ model, pass, config, profile, context: request.context });
    // The deep and fast passes key differently (model, effort); a lookup consults both so a fast pass is skipped
    // for blocks that already have a deep entry and the merged result always serves the best pass per block.
    const deepKey = computeCacheKey({ model: models.deep, pass: 'deep', config, profile, context: request.context });
    const fastKey = computeCacheKey({ model: models.fast, pass: 'fast', config, profile, context: request.context });
    const lookup = (hash: string): BlockCacheEntry | undefined => {
      let best: BlockCacheEntry | undefined;
      for (const key of new Set([deepKey, fastKey, cacheKey])) {
        const e = deps.cache.get(key, hash);
        if (e && (!best || PASS_RANK[e.pass] > PASS_RANK[best.pass])) best = e;
      }
      return best;
    };
    const enabledCategories: SuggestionCategory[] = CATEGORIES.filter((c) => config.categories[c]);

    const voiceCtx = ctxToVoice(request.context);
    const voiceProfile = voiceCtx ? profile.voice.profiles[voiceCtx] : undefined;
    const voiceSettings = profile.voice.settings.value;
    // A profile synced from another device is untrusted input: one that fails the lint is never rendered.
    const voiceBlock = voiceSettings.strength > 0 && voiceProfile && lintVoiceProfile(voiceProfile, voiceSettings.notes).ok ? renderVoiceBlock(voiceProfile, voiceSettings) : '';

    const paragraphs = [...request.blocks].sort((a, b) => a.index - b.index).filter((p) => p.text.trim().length > 0);
    const dirty = request.dirtyBlockHashes === 'all' ? null : new Set(request.dirtyBlockHashes);
    const requestedRank = PASS_RANK[pass];
    const neededNow = (): Paragraph[] =>
      paragraphs.filter((p) => {
        if (dirty !== null && !dirty.has(p.hash)) return false;
        const entry = lookup(p.hash);
        return !(entry && PASS_RANK[entry.pass] >= requestedRank);
      });
    let needed = neededNow();

    const fresh = new Set<string>();
    let outcome = emptyOutcome(model);
    let coveredAll = false;

    /** The merged best-per-block result for the whole field, from the cache (plus `error` when given). */
    const serve = (error?: CheckError): CheckResult => {
      const covered: CheckedBlock[] = [];
      const served: Suggestion[] = [];
      for (const p of paragraphs) {
        const entry = lookup(p.hash);
        if (!entry) continue;
        covered.push({ hash: p.hash, pass: entry.pass, model: entry.model, fromCache: !fresh.has(p.hash) });
        served.push(...serveCached(entry, p, request.fieldId, request.text));
      }
      const suggestions = finish(request, ctx, served);
      const result: CheckResult = {
        fieldId: request.fieldId,
        version: request.version,
        pass,
        suggestions,
        score: computeScore(request.text, suggestions),
        fromCache: outcome.calls === 0,
        blocks: covered,
        model: outcome.calls > 0 ? outcome.model : model,
      };
      if (outcome.calls > 0) result.usage = outcome.usage;
      if (error) result.error = error;
      return result;
    };
    const textHash = hashText(request.text);
    const oweDeep = (): void => {
      if (pass !== 'deep') return;
      const prev = owedDeep.get(request.fieldId);
      const attempts = prev && prev.textHash === textHash ? prev.attempts : 0;
      if (attempts >= OWED_DEEP_ATTEMPTS) {
        clearOwed(request.fieldId);
        return;
      }
      owedDeep.set(request.fieldId, { textHash, attempts: attempts + 1 });
      latestText.set(request.fieldId, textHash);
      scheduleOwed(request, ctx, textHash);
    };

    if (needed.length > 0) {
      progress('queued');
      const estWords = needed.reduce((sum, p) => sum + countWords(p.text), 0);
      const price = priceForModel(model);
      const estimateUsd = price ? (estWords * EST_TOKENS_PER_WORD * price.input + EST_OUTPUT_TOKENS * price.output) / 1_000_000 : 0;
      if (wouldExceedBudget(budget, estimateUsd)) {
        send({ type: 'check-result', result: serve(checkError('budget', false)) });
        return;
      }

      const laneHandle = openLane(request.fieldId, pass, textHash);
      try {
        if (pass === 'deep') {
          // Never run next to a fast call of the same field: let it land first (its suggestions show sooner).
          const fast = lanes.get(request.fieldId)?.fast;
          if (fast && fast.started) await waitLane(fast, signal);
        } else {
          // A fast pass that is still waiting (cooldown) yields to a deep pass for the same text that is already on
          // its way: the deep result covers these blocks, so this pass is served from its cache entries instead.
          await waitForCooldown(signal);
          const deep = lanes.get(request.fieldId)?.deep;
          if (deep && deep.textHash === textHash) {
            await waitLane(deep, signal);
            needed = neededNow();
          }
        }
        laneHandle.lane.started = true;

        if (needed.length > 0) {
          let sentEmitted = false;
          let streamingEmitted = false;
          const callOnce = async (paras: Paragraph[]): Promise<ShardOutcome> => {
            const blockIds = paras.map((p) => blockIdFor(p.index));
            const messages = buildCheckMessages(request, blockIds, {
              ...(voiceBlock.length > 0 ? { voiceBlock } : {}),
              maxBlocksPerRequest: MAX_BLOCKS_PER_CALL,
              goals: config.goals,
              dialect: config.dialect,
              styleDecisions: config.styleDecisions,
              protectedTerms: config.dictionary,
              customInstructions: profile.settings.customInstructions.value,
              mutedRules: config.mutedRules,
            });
            await waitForCooldown(signal);
            const release = await sem.acquire(signal);
            deps.keepalive?.begin();
            state.sent = true;
            try {
              if (!sentEmitted) {
                sentEmitted = true;
                progress('sent');
              }
              const result = await provider.check(
                { system: messages.system, user: messages.user, request, blockIds },
                {
                  model,
                  pass,
                  signal,
                  onFirstToken: () => {
                    if (!streamingEmitted) {
                      streamingEmitted = true;
                      progress('streaming');
                    }
                  },
                },
              );
              deps.usage.record(result.usage, result.model);
              const output = parseEngineOutput(result.output);
              const anchored = anchorSuggestions(output, messages.blocks, request.blocks, request.text, {
                model: result.model,
                promptVersion: PROMPT_VERSION,
                categories: enabledCategories,
              });
              // Cache every requested block (including blocks with zero suggestions) under the pass that produced them.
              const byBlock = new Map<string, Suggestion[]>();
              for (const s of anchored.suggestions) {
                const list = byBlock.get(s.blockId) ?? [];
                list.push(s);
                byBlock.set(s.blockId, list);
              }
              for (const p of paras) {
                const id = blockIdFor(p.index);
                if (!messages.blocks.some((b) => b.blockId === id)) continue;
                const existing = deps.cache.get(cacheKey, p.hash);
                if (existing && PASS_RANK[existing.pass] > PASS_RANK[pass]) continue; // never downgrade deep -> fast
                deps.cache.set(cacheKey, p.hash, { pass, model: result.model, suggestions: toCached(byBlock.get(id) ?? [], p), at: now() });
                fresh.add(p.hash);
              }
              return { suggestions: anchored.suggestions, blocks: messages.blocks, failed: [], usage: result.usage, model: result.model, tone: output.document.tone, calls: 1 };
            } finally {
              deps.keepalive?.end();
              release();
            }
          };

          const callShard = async (paras: Paragraph[], allowSplit: boolean, attempt = 0): Promise<ShardOutcome> => {
            try {
              return await callOnce(paras);
            } catch (e) {
              if (isProviderError(e) && e.code === 'rate-limit') {
                noteRateLimit(e, attempt);
                if (attempt < rl.retries && !signal.aborted) return callShard(paras, allowSplit, attempt + 1);
                // Still throttled: these paragraphs fail, the other shards keep what they got.
                const failed = emptyOutcome(model);
                const error = checkError('rate-limit', true, e.message, Math.max(0, cooldownUntil - now()));
                failed.failed = paras.map((p) => ({ hash: p.hash, error }));
                return failed;
              }
              if (isProviderError(e) && (e.code === 'truncated' || e.code === 'refusal')) {
                if (e.code === 'truncated' && allowSplit && paras.length > 1) {
                  const mid = Math.ceil(paras.length / 2);
                  const [a, b] = await Promise.all([callShard(paras.slice(0, mid), false), callShard(paras.slice(mid), false)]);
                  return mergeOutcomes(a, b);
                }
                const failed = emptyOutcome(model);
                failed.failed = paras.map((p) => ({ hash: p.hash, error: checkError(e.code, false) }));
                return failed;
              }
              throw e;
            }
          };

          const shards = shardBlocks(needed);
          let outcomes: ShardOutcome[];
          try {
            outcomes = await Promise.all(shards.map((sh) => callShard(sh, true)));
          } catch (e) {
            if (signal.aborted || isAbortError(e) || (isProviderError(e) && e.code === 'cancelled')) throw e;
            if (state.superseded) return;
            // A hard failure (auth, network, spend cap): keep serving what the cache already has for the field.
            const error = toCheckError(e);
            if (error.retryable) oweDeep();
            send({ type: 'check-result', result: serve(error) });
            return;
          }
          outcome = outcomes.reduce((acc, o) => mergeOutcomes(acc, o), emptyOutcome(model));
          if (signal.aborted) return;
          coveredAll = outcome.calls === 1 && outcome.failed.length === 0 && needed.length === paragraphs.length;
        }
      } finally {
        laneHandle.close();
      }
    }

    // A superseded run only filled the cache; the newer request reports for the field.
    if (state.superseded) return;
    const result = serve();
    if (coveredAll && outcome.tone.length > 0) result.tone = { labels: outcome.tone, summary: toneSummaryFor(outcome.tone) };
    const firstFailure = outcome.failed[0];
    if (firstFailure === undefined) {
      send({ type: 'check-result', result });
    } else if (outcome.calls === 0) {
      // Nothing came back: one error result (the content script schedules its own retry for a rate limit).
      send({ type: 'check-result', result: { ...result, error: firstFailure.error } });
    } else {
      // Some paragraphs came back: deliver them first (the content script applies only error-free results), then
      // report the paragraphs that failed.
      send({ type: 'check-result', result });
      send({ type: 'check-result', result: { ...result, error: firstFailure.error } });
    }
    if (outcome.failed.some((f) => f.error.retryable)) oweDeep();
    else if (pass === 'deep') clearOwed(request.fieldId);

    if (signal.aborted) return;
    if (result.tone) {
      // The main call already described the whole text: no separate tone call.
      deps.tone?.remember(request, result.tone);
    } else if (deps.tone) {
      void deps.tone.maybeRun(request, {
        provider,
        model: models.fast,
        send: (tone) => {
          if (!signal.aborted) ctx.send({ type: 'tone', fieldId: request.fieldId, version: request.version, tone });
        },
        onUsage: (usage) => deps.usage.record(usage, models.fast),
      });
    }

    // A deep pass for this text failed earlier (rate limit): now that calls go through again, run it.
    const owed = owedDeep.get(request.fieldId);
    if (pass === 'fast' && firstFailure === undefined && owed && owed.textHash === textHash && !inflight.has(`${request.fieldId}|deep`)) runOwed(request, ctx);
  }

  async function check(request: CheckRequest, ctx: EngineContext): Promise<void> {
    const key = `${request.fieldId}|${request.pass}`;
    if (request.pass !== 'rules' && owedDeep.has(request.fieldId)) latestText.set(request.fieldId, hashText(request.text));
    const prev = inflight.get(key);
    let after: Promise<void> | undefined;
    if (prev) {
      if (prev.sent && !prev.controller.signal.aborted) {
        prev.superseded = true;
        after = prev.done;
      } else {
        prev.controller.abort();
        after = prev.after;
      }
    }
    const controller = new AbortController();
    let settle: () => void = () => undefined;
    const entry: RunState = { controller, version: request.version, sent: false, superseded: false, done: new Promise<void>((r) => (settle = r)) };
    if (after) entry.after = after;
    inflight.set(key, entry);
    track(request.fieldId, controller);
    const requestId = `${request.fieldId}:${request.version}:${request.pass}`;
    deps.inflight?.add({ requestId, fieldId: request.fieldId, version: request.version, pass: request.pass, tabId: ctx.tabId ?? null, frameId: ctx.frameId ?? null, at: new Date(now()).toISOString() });
    try {
      if (after) await waitFor(after, controller.signal);
      await run(request, ctx, entry);
    } catch (e) {
      if (controller.signal.aborted || entry.superseded || isAbortError(e) || (e instanceof ProviderError && e.code === 'cancelled')) return;
      ctx.send({ type: 'check-result', result: errorResult(request, toCheckError(e)) });
    } finally {
      settle();
      deps.inflight?.remove(requestId);
      untrack(request.fieldId, controller);
      if (inflight.get(key) === entry) inflight.delete(key);
    }
  }

  return {
    get inFlight() {
      return sem.inUse + sem.queued;
    },
    check,
    cancel(fieldId) {
      for (const c of byField.get(fieldId) ?? []) c.abort();
      clearOwed(fieldId);
      deps.tone?.cancel(fieldId);
    },
  };
}
