/** zod schemas for request bodies (the profile document and op schemas live in @jammarly/shared/merge). */
import { z } from 'zod';
import type { EventsUploadRequest, LearningRunRequest, ProfileOpsRequest } from '@jammarly/shared/api';
import type { FeedbackEvent, VoiceSample } from '@jammarly/shared/learning';
import { DialectSchema, HostSchema, IsoDateSchema, VoiceContextSchema, WritingContextSchema, WritingGoalsSchema } from '@jammarly/shared/merge';

export const EVENTS_PER_BATCH = 500;
export const SNIPPET_MAX = 200;
export const SENTENCE_MAX = 280;

export const LoginSchema = z.object({ password: z.string().min(1).max(1024) });

export const ServerKeySchema = z.object({ apiKey: z.string().min(20).max(256) });

export const ProfileOpsSchema = z.object({
  baseVersion: z.number().int().min(0),
  ops: z.array(z.unknown()).min(1).max(200),
}) satisfies z.ZodType<ProfileOpsRequest>;

export const LearningRunSchema = z.object({
  contexts: z.array(VoiceContextSchema).min(1).max(2).optional(),
  statsOnly: z.boolean().optional(),
}) satisfies z.ZodType<LearningRunRequest>;

const snippet = z.string().max(SNIPPET_MAX);

export const FeedbackEventSchema = z.object({
  v: z.literal(1),
  eventId: z.string().min(1).max(64),
  t: IsoDateSchema,
  deviceId: z.string().max(64),
  model: z.string().max(100).optional(),
  promptVersion: z.string().max(40),
  profileVersion: z.number().int().min(0).optional(),
  profileStrength: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  goals: WritingGoalsSchema,
  dialect: DialectSchema,
  kind: z.enum(['shown', 'accept', 'dismiss', 'ignore', 'accepted_by_typing', 'self_corrected', 'edit_after_accept', 'invalidated', 'add_to_dictionary', 'report_incorrect']),
  suggestionId: z.string().max(128),
  fieldId: z.string().max(128),
  docKey: z.string().max(64),
  host: z.string().max(253),
  ctx: WritingContextSchema,
  rule: z.string().min(1).max(64),
  category: z.enum(['correctness', 'clarity', 'engagement', 'delivery']),
  severity: z.enum(['error', 'warning', 'suggestion']),
  confidence: z.number().min(0).max(1),
  source: z.enum(['rules', 'llm', 'both']),
  via: z.enum(['card', 'panel', 'bulk', 'keyboard', 'typing']).optional(),
  reason: z.enum(['not_error', 'meant_this', 'dislike_rewrite', 'not_here', 'not_this_site', 'never']).optional(),
  probe: z.boolean().optional(),
  dwellMs: z.number().min(0).optional(),
  original: snippet.optional(),
  replacement: snippet.optional(),
  final: snippet.optional(),
  sentence: z.string().max(SENTENCE_MAX).optional(),
  spanLen: z.number().int().min(0),
  sentenceLen: z.number().int().min(0),
  wordCountTyped: z.number().int().min(0).optional(),
}) satisfies z.ZodType<FeedbackEvent, unknown>;

export const VoiceSampleSchema = z.object({
  t: IsoDateSchema,
  host: HostSchema.or(z.literal('')),
  ctx: WritingContextSchema,
  voiceContext: VoiceContextSchema,
  sentence: z.string().min(1).max(SENTENCE_MAX),
}) satisfies z.ZodType<VoiceSample, unknown>;

export const EventsUploadSchema = z.object({
  events: z.array(FeedbackEventSchema).max(EVENTS_PER_BATCH),
  samples: z.array(VoiceSampleSchema).max(EVENTS_PER_BATCH).optional(),
}) satisfies z.ZodType<EventsUploadRequest, unknown>;
