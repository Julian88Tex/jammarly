/**
 * Environment variables, parsed lazily with zod. Nothing here runs at import time: `getEnv()` parses on the
 * first call (per process) and throws an `EnvError` with a clear, secret-free message when something is
 * missing or malformed. Route handlers turn that into a 500 `internal` response.
 */
import { z } from 'zod';

export const EXTENSION_ID_RE = /^[a-p]{32}$/;

const EnvSchema = z.object({
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JSLICE_URL: z
    .string()
    .url('expected the JSlice origin, e.g. https://jslice.vercel.app')
    .transform((s) => new URL(s).origin),
  CRON_SECRET: z.string().min(16, 'must be at least 16 characters'),
  APP_ORIGIN: z
    .string()
    .url('expected the production origin, e.g. https://jammarly-web.vercel.app')
    .transform((s) => new URL(s).origin),
  EXTENSION_IDS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((id) => id.trim().toLowerCase())
        .filter((id) => id.length > 0),
    )
    .refine((ids) => ids.every((id) => EXTENSION_ID_RE.test(id)), 'each id must be 32 characters a-p'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  override readonly name = 'EnvError';
}

let cached: Env | null = null;

/** Parse and cache the environment. Throws EnvError (never at import). */
export function getEnv(): Env {
  if (cached !== null) return cached;
  const raw: Record<string, string | undefined> = {
    SESSION_SECRET: process.env.SESSION_SECRET,
    JSLICE_URL: process.env.JSLICE_URL,
    CRON_SECRET: process.env.CRON_SECRET,
    APP_ORIGIN: process.env.APP_ORIGIN,
    EXTENSION_IDS: process.env.EXTENSION_IDS,
    ANTHROPIC_API_KEY: emptyToUndefined(process.env.ANTHROPIC_API_KEY),
    BLOB_READ_WRITE_TOKEN: emptyToUndefined(process.env.BLOB_READ_WRITE_TOKEN),
    NODE_ENV: process.env.NODE_ENV,
  };
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvError(`Missing or invalid environment variables: ${problems.join('; ')}`);
  }
  cached = parsed.data;
  return cached;
}

/** Tests change process.env between cases; clear the cache so the next getEnv() re-parses. */
export function resetEnvForTests(): void {
  cached = null;
}

/** True when the process is running on Vercel (OIDC Blob auth is available). */
export function isVercelRuntime(): boolean {
  return process.env.VERCEL === '1' || typeof process.env.VERCEL_OIDC_TOKEN === 'string';
}

function emptyToUndefined(v: string | undefined): string | undefined {
  return v === undefined || v.trim().length === 0 ? undefined : v;
}
