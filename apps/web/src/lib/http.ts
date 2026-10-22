/**
 * Route-handler plumbing: typed API errors, JSON responses that always carry the CORS headers, request
 * body validation with zod, and the `route()` wrapper that maps every failure onto `{ error: { code, message } }`.
 */
import type { ZodType } from 'zod';
import type { ApiError, ApiErrorCode } from '@jammarly/shared/api';
import { EnvError } from './env';
import { ApiRouteError } from './errors';
import { corsHeadersFor, enforceOriginPolicy, type OriginPolicy } from './cors';

export { ApiRouteError };

export const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' } as const;

function withCors(req: Request, headers: HeadersInit | undefined): Headers {
  const h = new Headers(headers);
  for (const [k, v] of Object.entries(corsHeadersFor(req))) h.set(k, v);
  return h;
}

/** JSON body with the CORS headers for this request. `data` may be undefined for a 204. */
export function jsonResponse(req: Request, data: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = withCors(req, init.headers);
  const status = init.status ?? 200;
  if (status === 204 || data === undefined) {
    headers.delete('Content-Type');
    return new Response(null, { status: status === 200 ? 204 : status, headers });
  }
  headers.set('Content-Type', JSON_HEADERS['Content-Type']);
  headers.set('Cache-Control', headers.get('Cache-Control') ?? 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorBody(code: ApiErrorCode, message: string, extra: Record<string, unknown> = {}): ApiError & Record<string, unknown> {
  return { ...extra, error: { code, message } };
}

export function errorResponse(req: Request, err: unknown): Response {
  if (err instanceof ApiRouteError) {
    return jsonResponse(req, errorBody(err.code, err.message, err.extra), { status: err.status });
  }
  if (err instanceof EnvError) {
    console.error(`[jammarly] ${err.message}`);
    return jsonResponse(req, errorBody('internal', err.message), { status: 500 });
  }
  const message = err instanceof Error ? err.message : 'unexpected error';
  console.error('[jammarly] unhandled route error:', message);
  return jsonResponse(req, errorBody('internal', 'Unexpected server error.'), { status: 500 });
}

/** Parse and validate a JSON body; 400 schema_invalid on malformed JSON or validation failure. */
export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.length === 0 ? {} : (JSON.parse(text) as unknown);
  } catch {
    throw new ApiRouteError(400, 'schema_invalid', 'Request body is not valid JSON.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : first.path.join('.');
    throw new ApiRouteError(400, 'schema_invalid', `Invalid request body${where.length > 0 ? ` at ${where}` : ''}: ${first?.message ?? 'validation failed'}`);
  }
  return parsed.data;
}

export type RouteContext<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };

/**
 * Wrap a handler: enforce the Origin policy, catch typed errors and always answer JSON with CORS headers.
 * `policy` says who may call the route (see ./cors).
 */
export function route<P extends Record<string, string> = Record<string, string>>(
  policy: OriginPolicy,
  fn: (req: Request, ctx: RouteContext<P>) => Promise<Response>,
): (req: Request, ctx: RouteContext<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      enforceOriginPolicy(req, policy);
      return await fn(req, ctx);
    } catch (err) {
      return errorResponse(req, err);
    }
  };
}

/** Client IP for rate limiting (Vercel sets x-forwarded-for / x-real-ip). */
export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff !== null && xff.length > 0) {
    const first = xff.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export function bearerToken(req: Request): string | null {
  const auth = req.headers.get('authorization');
  if (auth === null) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m?.[1]?.trim() ?? null;
}
