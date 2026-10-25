/**
 * Web app API contracts (apps/web route handlers <-> extension sync client and dashboard).
 * All bodies are JSON. Errors are { error: { code, message } } with a 4xx/5xx status.
 */
import type { LearningSummary, FeedbackEvent, VoiceSample } from './learning';
import type { ProfileDocument, ProfileOp, VoiceContext } from './profile';

export type ApiErrorCode =
  | 'unauthorized'
  | 'device_revoked'
  | 'pairing_invalid'
  | 'pairing_expired'
  | 'precondition_failed'
  | 'conflict_retry'
  | 'quota_exceeded'
  | 'hlc_skew'
  | 'schema_invalid'
  | 'op_not_allowed'
  | 'rate_limited'
  | 'not_found'
  | 'server_key_missing'
  | 'internal';

export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}

export const ETAG_HEADER = 'ETag';
export const IF_MATCH_HEADER = 'If-Match';
export const IF_NONE_MATCH_HEADER = 'If-None-Match';
export const PROFILE_VERSION_HEADER = 'X-Profile-Version';

export interface DevicesListResponse {
  devices: DeviceInfo[];
}

export interface RotateResponse {
  token: string;
  /** The previous token keeps working until this time (5 minutes). */
  previousValidUntil: string;
}

/** Tiny document polled by devices; served with default caching so hits are free. */
export interface ProfileVersionResponse {
  version: number;
  etag: string;
}

/** Body of a 412 on PUT /api/profile or POST /api/profile/ops after retries. */
export interface ProfilePutConflict extends ApiError {
  current: ProfileGetResponse;
}

export interface LearningDataDeleteResponse {
  deleted: { events: number; samples: number; snapshots: number; runs: number };
}

export interface ExportResponse {
  exportedAt: string;
  profile: ProfileDocument;
  devices: DeviceInfo[];
  events: FeedbackEvent[];
  samples: VoiceSample[];
}

export interface ServerKeyStatusResponse {
  configured: boolean;
  /** Last 4 characters, for recognition only. */
  hint: string;
}

export interface LearningRunStatus {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  stage: 'queued' | 'fold' | 'learner' | 'synthesize' | 'lint' | 'store' | 'done' | 'failed' | 'partial';
  context?: VoiceContext;
  message?: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  extVersion: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface PairStartResponse {
  pairingId: string;
  code: string;
  expiresAt: string;
}

export interface PairRedeemRequest {
  pairingId: string;
  code: string;
  device: { name: string; platform: string; extVersion: string };
}

export interface PairRedeemResponse {
  deviceId: string;
  token: string;
  profile: ProfileDocument;
  etag: string;
  version: number;
}

export interface ProfileGetResponse {
  profile: ProfileDocument;
  etag: string;
  version: number;
}

export interface ProfileOpsRequest {
  /** Informational: the version the device last merged. The server always merges with the current document. */
  baseVersion: number;
  ops: ProfileOp[];
}

export interface ProfileOpsResponse {
  profile: ProfileDocument;
  etag: string;
  version: number;
}

export interface EventsUploadRequest {
  events: FeedbackEvent[];
  samples?: VoiceSample[];
}

export interface EventsUploadResponse {
  accepted: number;
  samplesAccepted: number;
}

export interface LearningRunRequest {
  contexts?: VoiceContext[];
  /** Skip the model call and only fold counters. */
  statsOnly?: boolean;
}

export interface LearningRunResponse {
  started: boolean;
  runId?: string;
  reason?: 'quota' | 'already_running' | 'nothing_new' | 'server_key_missing';
}

export type LearningSummaryResponse = LearningSummary;

export interface HealthResponse {
  ok: true;
  version: string;
}

/**
 * Message the dashboard posts to the extension via chrome.runtime.sendMessage(EXTENSION_ID, ...).
 * The worker trusts only sender.origin (must equal its compiled APP_ORIGIN); appOrigin here is display-only.
 */
export interface ExternalPairMessage {
  type: 'jammarly.pair';
  pairingId: string;
  code: string;
  appOrigin: string;
}

export interface ExternalPairReply {
  ok: boolean;
  deviceId?: string;
  error?: string;
}
