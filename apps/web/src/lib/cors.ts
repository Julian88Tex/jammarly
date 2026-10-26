/**
 * CORS and Origin policy (architecture §4 "API", research 07 §5.2):
 *
 * - Requests whose `Origin` is `chrome-extension://<id>` with `id ∈ EXTENSION_IDS` get the allow headers echoed
 *   back (with `Vary: Origin`), never credentials. Any other origin gets nothing.
 * - Cookie-authenticated (session) routes reject requests that carry any extension Origin, and any cross-site
 *   browser Origin, with 403.
 * - Device routes reject browser origins that are not an allowed extension with 403.
 */
import { getEnv } from './env';
import { ApiRouteError } from './errors';

export type OriginPolicy = 'session' | 'device' | 'shared' | 'public';

export const CORS_METHODS = 'GET,POST,PUT,DELETE,OPTIONS';
export const CORS_HEADERS = 'Authorization, Content-Type, If-Match, If-None-Match';
export const CORS_EXPOSE = 'ETag, X-Profile-Version';

const EXT_ORIGIN_RE = /^chrome-extension:\/\/([a-p]{32})$/;

/** The extension id when `origin` is a chrome-extension origin, otherwise null. */
export function parseExtensionOrigin(origin: string | null | undefined): string | null {
  if (typeof origin !== 'string') return null;
  const m = EXT_ORIGIN_RE.exec(origin.trim().toLowerCase());
  return m?.[1] ?? null;
}

export function isAnyExtensionOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && origin.trim().toLowerCase().startsWith('chrome-extension://');
}

export function isAllowedExtensionOrigin(origin: string | null | undefined): boolean {
  const id = parseExtensionOrigin(origin);
  if (id === null) return false;
  return getEnv().EXTENSION_IDS.includes(id);
}

/** The app's own origin: APP_ORIGIN, or the request's host for local development. */
function selfOrigins(req: Request): Set<string> {
  const out = new Set<string>([getEnv().APP_ORIGIN]);
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (host !== null) {
    const proto = req.headers.get('x-forwarded-proto') ?? (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
    out.add(`${proto}://${host}`);
  }
  try {
    out.add(new URL(req.url).origin);
  } catch {
    // ignore
  }
  return out;
}

export function isSelfOrigin(req: Request, origin: string): boolean {
  return selfOrigins(req).has(origin.trim().toLowerCase());
}

/** Headers to add to every response for this request (empty for non-extension or unknown origins). */
export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (origin === null || !isAllowedExtensionOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin.trim().toLowerCase(),
    Vary: 'Origin',
    'Access-Control-Allow-Methods': CORS_METHODS,
    'Access-Control-Allow-Headers': CORS_HEADERS,
    'Access-Control-Expose-Headers': CORS_EXPOSE,
    'Access-Control-Max-Age': '86400',
  };
}

/** Answer a preflight: 204 with the allow headers when the origin is an allowed extension, bare 204 otherwise. */
export function preflight(req: Request): Response {
  let headers: Record<string, string> = {};
  try {
    headers = corsHeadersFor(req);
  } catch {
    headers = {};
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Enforce who may call a route based on the Origin header. Bearer-token routes are CSRF-immune by
 * construction, so the check there only rejects browser pages that are not the extension.
 */
export function enforceOriginPolicy(req: Request, policy: OriginPolicy): void {
  const origin = req.headers.get('origin');
  if (policy === 'public' || origin === null || origin.length === 0 || origin === 'null') return;
  const extension = isAnyExtensionOrigin(origin);
  if (policy === 'session') {
    if (extension) throw new ApiRouteError(403, 'unauthorized', 'This route cannot be called from an extension origin.');
    if (!isSelfOrigin(req, origin)) throw new ApiRouteError(403, 'unauthorized', 'Cross-site requests are not allowed on this route.');
    return;
  }
  if (policy === 'device') {
    if (!isAllowedExtensionOrigin(origin)) throw new ApiRouteError(403, 'unauthorized', 'Origin is not an allowed extension.');
    return;
  }
  // shared: decided by the credential that is present.
  const hasBearer = req.headers.get('authorization') !== null;
  if (hasBearer) {
    if (!isAllowedExtensionOrigin(origin)) throw new ApiRouteError(403, 'unauthorized', 'Origin is not an allowed extension.');
    return;
  }
  if (extension) throw new ApiRouteError(403, 'unauthorized', 'Cookie sessions cannot be used from an extension origin.');
  if (!isSelfOrigin(req, origin)) throw new ApiRouteError(403, 'unauthorized', 'Cross-site requests are not allowed on this route.');
}
