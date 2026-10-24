/**
 * Proxy (Next 16's middleware): a cheap presence check of the session cookie for the dashboard pages so an
 * unauthenticated visit redirects to /login before rendering. The real check (unsealing the cookie) happens in
 * the dashboard layout; API routes authenticate themselves.
 */
import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'jammarly_session';

export function proxy(request: NextRequest): NextResponse {
  const hasCookie = request.cookies.get(SESSION_COOKIE) !== undefined;
  const { pathname } = request.nextUrl;
  if (!hasCookie) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/overview/:path*', '/tuning/:path*', '/voice/:path*', '/learning/:path*', '/privacy/:path*'],
};
