/**
 * Content-script controller: everything between the adapter/UI interfaces and the service worker.
 * `startContentScript(deps)` wires the registry, the port and the overlay; the content-script entry passes the real
 * detect/sites/adapters/ui modules, tests pass fakes.
 */
export { Registry, defaultConfig, instanceId, isGoogleDocsDocument, createSentinelAdapter, INSTANCE_ATTR, TAKEOVER_EVENT, GDOCS_STATUS_EVENT, DETACH_SWEEP_MS, DETACH_GRACE_MS, OPT_OUT_REASON, GDOCS_UNSUPPORTED_REASON } from './registry';
export type { ControllerDeps, AdapterFactory } from './registry';
export { FieldSession, computeStatus, overlayOptionsFor, TYPING_IDLE_MS, FEEDBACK_IDLE_MS, FIELD_STATE_DEBOUNCE_MS, INPUT_MIN_WORDS, TEXT_PREVIEW_CHARS } from './session';
export type { SessionDeps, FieldStatePayload, StatusInput } from './session';
export { PortClient, isWorkerToContent, CONTENT_PORT_NAME, PING_INTERVAL_MS, DEFAULT_BACKOFF_MS } from './port-client';
export type { PortClientOptions, PortState } from './port-client';
export { TextModel, shiftRangeThrough, provenanceForInputType, isPasteLike, DEFAULT_MAX_LOG } from './text-model';
export type { Provenance, ProvenanceRange, TextChange, ChangeSource } from './text-model';
export { Scheduler, passFor, endsSentence, countSentences, RULES_COALESCE_MS, PASTE_SENTENCE_MIN } from './scheduler';
export type { SchedulerConfig, SchedulerHooks, ChangeInfo, PassTrigger, RequestedPass } from './scheduler';
export { SuggestionStore, mergeSuggestions, rebaseAcrossChange, stabilizeRuleIds, selectAcceptAll, acceptAllCounts, isSpanEdit, editKey, DEFAULT_FILTERS } from './store';
export type { StoreFilters, MergeInput, OwnEdit, RebaseResult, AcceptAllSelection } from './store';
export { ApplyEngine, editForSuggestion, validateEdit, postApplyEdits, sameEdit, waitForCompositionEnd, MAX_TRANSACTIONS, COMPOSITION_SETTLE_MS } from './apply';
export type { ApplyHost, AcceptResult, AcceptAllResult, UndoResult, AcceptStatus } from './apply';
export { FeedbackTracker, voiceContextFor, locateByContext, FLUSH_INTERVAL_MS, FLUSH_BATCH, IGNORE_DWELL_MS, TYPING_WINDOW_MS, VOICE_MIN_WORDS, VOICE_MAX_CHARS } from './feedback';
export type { FeedbackDeps } from './feedback';
export { realTimers, rangesIntersect, rangeContains, sameText, normalizeNbsp, sentenceContaining, fieldPath, computeDocKey, extensionVersion, safeRuntime, randomToken } from './util';
export type { Timers, RuntimeLike, PortLike } from './util';

import type { ControllerDeps } from './registry';
import { Registry } from './registry';

/** Creates and starts the registry for this document; null when the same instance already runs here. */
export function startContentScript(deps: ControllerDeps): Registry | null {
  const registry = new Registry(deps);
  return registry.start() ? registry : null;
}
