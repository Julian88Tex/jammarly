/** Shared test harness: env, in-memory blob store, session cookies, paired devices and fixture builders. */
import type { PairRedeemResponse, PairStartResponse } from '@jammarly/shared/api';
import { formatHlc } from '@jammarly/shared/hlc';
import type { FeedbackEvent, VoiceSample } from '@jammarly/shared/learning';
import { SignJWT, generateKeyPair, type CryptoKey } from 'jose';
import { MemoryBlobStore, setBlobStoreForTests } from '@/lib/blob';
import { resetDeviceIndexCacheForTests } from '@/lib/devices';
import { resetEnvForTests } from '@/lib/env';
import { JSLICE_APP_ID, setJSliceKeySetForTests } from '@/lib/jslice';
import { setBackgroundModeForTests } from '@/lib/learning/background';
import { resetSummaryCacheForTests } from '@/lib/learning/data';
import { resetStoreCachesForTests, userPaths } from '@/lib/store';

export const JSLICE_URL = 'https://jslice.vercel.app';
/** The default signed-in user (a Google subject id, as JSlice sends it). */
export const TEST_UID = '109876543210987654321';
export const OTHER_UID = '100000000000000000042';
/** Paths of the default user's documents. */
export const P = userPaths(TEST_UID);
export const TEST_CRON_SECRET = 'cron-secret-0123456789abcdef';
export const EXT_ID = 'hkobmhfcoefpipbfkihdbbkgblckhkae';
export const OTHER_EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const APP_ORIGIN = 'https://jammarly-web.vercel.app';
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;

export function setupEnv(overrides: Record<string, string | undefined> = {}): void {
  const env: Record<string, string | undefined> = {
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-0123456789',
    JSLICE_URL,
    CRON_SECRET: TEST_CRON_SECRET,
    APP_ORIGIN,
    EXTENSION_IDS: EXT_ID,
    ANTHROPIC_API_KEY: undefined,
    BLOB_READ_WRITE_TOKEN: undefined,
    NODE_ENV: 'test',
    VERCEL: undefined,
    VERCEL_OIDC_TOKEN: undefined,
    ...overrides,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvForTests();
}

/** A fresh in-memory store plus every module-level cache reset. */
export function freshStore(now?: () => number): MemoryBlobStore {
  setupEnv();
  const store = new MemoryBlobStore(now);
  setBlobStoreForTests(store);
  resetStoreCachesForTests();
  resetSummaryCacheForTests();
  resetDeviceIndexCacheForTests();
  setBackgroundModeForTests('inline');
  return store;
}

export interface ReqInit {
  method?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export function req(path: string, init: ReqInit = {}): Request {
  const headers = new Headers(init.headers ?? {});
  let body: string | undefined;
  if (init.rawBody !== undefined) body = init.rawBody;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  }
  return new Request(`${APP_ORIGIN}${path}`, { method: init.method ?? (body === undefined ? 'GET' : 'POST'), headers, ...(body === undefined ? {} : { body }) });
}

export const params = <P extends Record<string, string>>(p: P): { params: Promise<P> } => ({ params: Promise.resolve(p) });

export async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function cookieFromResponse(res: Response): string {
  const all = res.headers.getSetCookie();
  const first = all.find((c) => c.startsWith('jammarly_session='));
  if (first === undefined) throw new Error('no session cookie in response');
  return first.split(';')[0] ?? '';
}

// ---------------------------------------------------------------------------
// JSlice tokens: a local ES256 key stands in for JSlice's JWKS.
// ---------------------------------------------------------------------------

let signingKey: Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> | null = null;

async function keys(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }> {
  signingKey ??= generateKeyPair('ES256');
  const k = await signingKey;
  setJSliceKeySetForTests(async () => k.publicKey);
  return k;
}

export interface TokenOptions {
  sub?: string;
  email?: string;
  name?: string;
  jti?: string;
  issuer?: string;
  audience?: string;
  /** Seconds since the epoch. */
  iat?: number;
  expiresInSeconds?: number;
  privateKey?: CryptoKey;
}

/** A hand-off token shaped like the ones JSlice mints. */
export async function jsliceToken(opts: TokenOptions = {}): Promise<string> {
  const { privateKey } = await keys();
  const iat = opts.iat ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ email: opts.email ?? 'writer@example.com', name: opts.name ?? 'Test Writer', picture: 'https://example.com/a.png' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(opts.issuer ?? JSLICE_URL)
    .setAudience(opts.audience ?? JSLICE_APP_ID)
    .setSubject(opts.sub ?? TEST_UID)
    .setJti(opts.jti ?? `jti_${Math.random().toString(36).slice(2)}_${Date.now()}`)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.expiresInSeconds ?? 60))
    .sign(opts.privateKey ?? privateKey);
}

/** Call the JSlice callback route with a token. */
export async function jsliceCallback(token: string | null, next?: string): Promise<Response> {
  await keys();
  const { GET } = await import('@/app/api/auth/jslice/route');
  const qs = new URLSearchParams();
  if (token !== null) qs.set('token', token);
  if (next !== undefined) qs.set('next', next);
  return GET(req(`/api/auth/jslice?${qs.toString()}`), params({}));
}

/** Sign in through the JSlice callback and return the session cookie. */
export async function loginCookie(sub: string = TEST_UID): Promise<string> {
  const res = await jsliceCallback(await jsliceToken({ sub }));
  if (res.status !== 302 || (res.headers.get('location') ?? '').includes('error=')) throw new Error(`sign-in failed: ${res.status} ${res.headers.get('location') ?? ''}`);
  return cookieFromResponse(res);
}

export function ownerHeaders(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, origin: APP_ORIGIN, ...extra };
}

export function deviceHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, origin: EXT_ORIGIN, ...extra };
}

export async function pairDevice(cookie: string, name = 'Chrome on macOS'): Promise<PairRedeemResponse> {
  const start = await import('@/app/api/devices/pair/start/route');
  const redeem = await import('@/app/api/devices/pair/redeem/route');
  const started = await json<PairStartResponse>(await start.POST(req('/api/devices/pair/start', { method: 'POST', headers: ownerHeaders(cookie) }), params({})));
  const res = await redeem.POST(
    req('/api/devices/pair/redeem', {
      body: { pairingId: started.pairingId, code: started.code, device: { name, platform: 'mac', extVersion: '0.1.0' } },
      headers: { origin: EXT_ORIGIN },
    }),
    params({}),
  );
  if (res.status !== 200) throw new Error(`redeem failed: ${res.status} ${await res.text()}`);
  return json<PairRedeemResponse>(res);
}

let eventCounter = 0;

export function makeEvent(overrides: Partial<FeedbackEvent> = {}): FeedbackEvent {
  eventCounter += 1;
  return {
    v: 1,
    eventId: `evt_${eventCounter}_${Math.random().toString(36).slice(2, 8)}`,
    t: new Date().toISOString(),
    deviceId: 'd_fixture',
    promptVersion: 'p1',
    profileStrength: 2,
    goals: { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' },
    dialect: 'en-US',
    kind: 'accept',
    suggestionId: 'sug_1',
    fieldId: 'field_1',
    docKey: 'doc0123456789abc',
    host: 'mail.google.com',
    ctx: 'email',
    rule: 'wordy_phrase',
    category: 'clarity',
    severity: 'suggestion',
    confidence: 0.9,
    source: 'llm',
    original: 'in order to finish on time',
    replacement: 'to finish on time',
    sentence: 'We left early in order to finish on time.',
    spanLen: 26,
    sentenceLen: 42,
    ...overrides,
  };
}

export function makeSample(overrides: Partial<VoiceSample> = {}): VoiceSample {
  return {
    t: new Date().toISOString(),
    host: 'mail.google.com',
    ctx: 'email',
    voiceContext: 'messages',
    sentence: "Thanks so much, I'll send the draft tonight and we can talk tomorrow.",
    ...overrides,
  };
}

export function hlc(deviceId = 'd_fixture', wallMs = Date.now(), counter = 0): string {
  return formatHlc({ wallMs, counter, deviceId });
}

/** A valid structured-output payload for the voice synthesis call (snake_case, as the model returns it). */
export function voiceOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context: 'messages',
    summary: 'Writes short, warm messages with contractions and a quick sign-off.',
    traits: [
      { id: 'short_sentences', label: 'Short sentences', description: 'Most sentences run under fourteen words.', dimension: 'sentences', evidence_count: 30, confidence: 'high', verified_in_samples: true },
      { id: 'contractions', label: 'Contractions', description: "Uses contractions such as I'll and don't in nearly every message.", dimension: 'register', evidence_count: 25, confidence: 'high', verified_in_samples: true },
    ],
    style_guide: 'Register: casual and friendly; contractions throughout.\nSentences: short, one idea each.\nPunctuation: single exclamation marks for thanks.\nWords: plain verbs.\nOpenings and closings: first-name greeting, signs off with Thanks!\nWhat to leave alone: fragments in replies.',
    editor_instructions: ['Keep rewrites short and conversational.'],
    do_not_flag_style: ['sentence_fragment', 'contractions'],
    keep_phrases: ['happy to', 'let me know'],
    avoid_phrases: ['per my last email'],
    greetings: ['Hi {name},'],
    signoffs: ['Thanks!'],
    accepted_patterns: ['shortening wordy phrases'],
    rejected_patterns: ['formalizing greetings'],
    examples: {
      accepted: [{ before: 'in order to finish on time', after: 'to finish on time' }],
      rejected: [{ before: "Thanks so much! I'll send it tonight.", proposed: 'Thank you. I will send it tonight.', kept_or_final: "Thanks so much! I'll send it tonight." }],
    },
    confidence: 'medium',
    changelog: 'First profile from 30 samples and 24 decisions.',
    ...overrides,
  };
}
