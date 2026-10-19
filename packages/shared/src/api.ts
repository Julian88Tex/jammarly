/**
 * Web app API contracts (apps/web route handlers <-> extension sync client and dashboard).
 * All bodies are JSON. Errors are { error: { code, message } } with a 4xx/5xx status.
 */
import type { LearningSummary, FeedbackEvent, VoiceSample } from './learning';
import type { ProfileDocument, ProfileOp, VoiceContext } from './profile';

export interface ApiError {
  error: { code: string; message: string };
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
  runId: string;
}

export type LearningSummaryResponse = LearningSummary;

export interface HealthResponse {
  ok: true;
  version: string;
}

/** Message the dashboard posts to the extension via chrome.runtime.sendMessage(EXTENSION_ID, ...). */
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
