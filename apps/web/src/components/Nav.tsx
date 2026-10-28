'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from './api-client';

const LINKS = [
  { href: '/overview', label: 'Overview' },
  { href: '/tuning', label: 'Tuning' },
  { href: '/voice', label: 'Voice' },
  { href: '/learning', label: 'Learning' },
  { href: '/privacy', label: 'Privacy and data' },
] as const;

export function Nav({ version, account }: { version: string; account: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      // jslice=none: do not try a silent JSlice sign-in right after signing out.
      router.replace('/login?jslice=none');
    }
  }

  return (
    <nav className="flex flex-col gap-1 p-3 md:sticky md:top-0 md:h-screen" aria-label="Dashboard">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        <span className="inline-block h-6 w-6 rounded-md bg-brand" aria-hidden="true" />
        <span className="text-[15px] font-semibold tracking-tight">Jammarly</span>
      </div>
      {LINKS.map((l) => {
        const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-2.5 py-1.5 font-medium transition ${active ? 'bg-brand/15 text-brand-strong dark:text-brand' : 'text-muted hover:bg-panel-2 hover:text-ink'}`}
          >
            {l.label}
          </Link>
        );
      })}
      {account.length > 0 ? (
        <p className="mt-auto truncate px-2 pt-4 text-[12.5px] text-muted" title={account}>
          {account}
        </p>
      ) : null}
      <div className={`${account.length > 0 ? '' : 'mt-auto '}flex items-center justify-between gap-2 px-2 pt-2 text-[12.5px] text-muted`}>
        <span>v{version}</span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={logout} disabled={busy}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
