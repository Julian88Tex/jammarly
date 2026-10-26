import { redirect } from 'next/navigation';
import { jsliceSignInUrl, jsliceSilentUrl, safeNext } from '@/lib/jslice';
import { getPageUser } from '@/lib/session';

export const metadata = { title: 'Sign in · Jammarly' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Sign-in goes through JSlice (Google single sign-on). A plain visit first tries a silent sign-in: JSlice
 * sends a signed-in visitor straight back with a token, and everyone else back here with `jslice=none`, which
 * shows the button. An `error` (a rejected token) also shows the button instead of looping.
 */
export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNext(first(params.next));
  if ((await getPageUser()) !== null) redirect(next);
  const error = first(params.error);
  if (first(params.jslice) !== 'none' && error === undefined) redirect(jsliceSilentUrl(next));

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center gap-2">
        <span className="inline-block h-6 w-6 rounded-md bg-brand" aria-hidden="true" />
        <span className="text-lg font-semibold tracking-tight">Jammarly</span>
      </div>
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mb-5 mt-1 text-muted">Use your Google account through JSlice. Your settings sync to every device you pair.</p>
      <div className="space-y-4 rounded-lg border border-line bg-panel p-4 shadow-sm">
        <a className="btn btn-primary w-full" href={jsliceSignInUrl(next)}>
          Continue with JSlice
        </a>
        {error !== undefined ? (
          <p className="text-[13px] text-danger" role="alert">
            That sign-in link was not accepted (it may have expired or been used already). Please try again.
          </p>
        ) : null}
      </div>
    </main>
  );
}
