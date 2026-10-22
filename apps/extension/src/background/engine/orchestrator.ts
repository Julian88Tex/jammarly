/**
 * Engine orchestration (ARCHITECTURE §3.2/§3.3): cache-keyed block checks with pass supersession, sharding,
 * truncation retry, cancellation of stale requests, a global in-flight cap, budget and consent gates, stable ids,
 * learned-state and dismissal filtering, and the separate tone call.
 *
 * `check()` never throws for a user-visible failure: it emits a `check-result` carrying `error`. A request that was
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
import { isAbortError, Semaphore, sleep, stableJson } from '../util';
import type { BlockCache } from './cache';
import type { Provider } from './provider';
import { addUsage, checkError, isProviderError, ProviderError, toCheckError, ZERO_USAGE } from './provider';
import { toneSummaryFor, type ToneRunner } from './tone';

export const MAX_BLOCKS_PER_CALL = 4;
export const MAX_WORDS_PER_CALL = 1200;
export const MAX_CONCURRENT_CALLS = 3;
/** Rate limits: every call waits out a shared cooldown, and a throttled call is retried this many times. */
export const RATE_LIMIT_RETRIES = 2;
export const RATE_LIMIT_MIN_WAIT_MS = 2_000;
export const RATE_LIMIT_MAX_WAIT_MS = 30_000;
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000];
/** Planning figures for the budget pre-check (research 02 reviewer A5). */
export const EST_TOKENS_PER_WORD = 1.8;
export const EST_OUTPUT_TOKENS = 400;

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
  rateLimit?: { retries?: number; minWaitMs?: number; maxWaitMs?: number; backoffMs?: number[] };
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

/** Splits paragraphs into calls of <= 4 blocks and <= 1,200 words (a single oversized block travels alone). */
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
  };
  const noteRateLimit = (e: ProviderError, attempt: number): number => {
    const suggested = e.retryAfterMs ?? rl.backoffMs[Math.min(attempt, rl.backoffMs.length - 1)] ?? rl.maxWaitMs;
    const wait = Math.min(rl.maxWaitMs, Math.max(rl.minWaitMs, suggested));
    cooldownUntil = Math.max(cooldownUntil, now() + wait);
    return wait;
  };
  const inflight = new Map<string, { controller: AbortController; version: number }>();
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

  async function run(request: CheckRequest, ctx: EngineContext, signal: AbortSignal): Promise<void> {
    const send = (msg: EngineMessage): void => {
      if (!signal.aborted) ctx.send(msg);
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
    const needed: Paragraph[] = [];
    for (const p of paragraphs) {
      if (dirty !== null && !dirty.has(p.hash)) continue;
      const entry = lookup(p.hash);
      if (entry && PASS_RANK[entry.pass] >= requestedRank) continue;
      needed.push(p);
    }

    const fresh = new Set<string>();
    let outcome = emptyOutcome(model);
    let coveredAll = false;

    if (needed.length > 0) {
      progress('queued');
      const estWords = needed.reduce((sum, p) => sum + countWords(p.text), 0);
      const price = priceForModel(model);
      const estimateUsd = price ? (estWords * EST_TOKENS_PER_WORD * price.input + EST_OUTPUT_TOKENS * price.output) / 1_000_000 : 0;
      if (wouldExceedBudget(budget, estimateUsd)) {
        send({ type: 'check-result', result: errorResult(request, checkError('budget', false)) });
        return;
      }

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
            throw new ProviderError('rate-limit', e.message, true, Math.max(0, cooldownUntil - now()));
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
      const outcomes = await Promise.all(shards.map((s) => callShard(s, true)));
      outcome = outcomes.reduce((acc, o) => mergeOutcomes(acc, o), emptyOutcome(model));
      if (signal.aborted) return;
      coveredAll = outcome.calls === 1 && outcome.failed.length === 0 && needed.length === paragraphs.length;
    }

    // Merge the best entry per block for the whole field.
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
    if (coveredAll && outcome.tone.length > 0) result.tone = { labels: outcome.tone, summary: toneSummaryFor(outcome.tone) };
    const firstFailure = outcome.failed[0];
    if (firstFailure) result.error = firstFailure.error;
    send({ type: 'check-result', result });

    if (deps.tone && !signal.aborted) {
      void deps.tone.maybeRun(request, {
        provider,
        model: models.fast,
        send: (tone) => {
          if (!signal.aborted) ctx.send({ type: 'tone', fieldId: request.fieldId, version: request.version, tone });
        },
        onUsage: (usage) => deps.usage.record(usage, models.fast),
      });
    }
  }

  return {
    get inFlight() {
      return sem.inUse + sem.queued;
    },
    async check(request, ctx) {
      const key = `${request.fieldId}|${request.pass}`;
      const prev = inflight.get(key);
      if (prev) prev.controller.abort();
      const controller = new AbortController();
      const entry = { controller, version: request.version };
      inflight.set(key, entry);
      track(request.fieldId, controller);
      const requestId = `${request.fieldId}:${request.version}:${request.pass}`;
      deps.inflight?.add({ requestId, fieldId: request.fieldId, version: request.version, pass: request.pass, tabId: ctx.tabId ?? null, frameId: ctx.frameId ?? null, at: new Date(now()).toISOString() });
      try {
        await run(request, ctx, controller.signal);
      } catch (e) {
        if (controller.signal.aborted || isAbortError(e) || (e instanceof ProviderError && e.code === 'cancelled')) return;
        ctx.send({ type: 'check-result', result: errorResult(request, toCheckError(e)) });
      } finally {
        deps.inflight?.remove(requestId);
        untrack(request.fieldId, controller);
        if (inflight.get(key) === entry) inflight.delete(key);
      }
    },
    cancel(fieldId) {
      for (const c of byField.get(fieldId) ?? []) c.abort();
      deps.tone?.cancel(fieldId);
    },
  };
}
