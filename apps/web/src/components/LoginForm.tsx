'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, describeError } from './api-client';
import { Field } from './ui';
import { StatusLine, idle, type Status } from './StatusLine';

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>(idle);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: 'busy', text: 'Signing in…' });
    try {
      await api('/api/auth/login', { body: { password } });
      const next = search.get('next');
      router.replace(next !== null && next.startsWith('/') && !next.startsWith('//') ? next : '/overview');
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-line bg-panel p-4 shadow-sm">
      <Field label="Password">
        <input className="field" type="password" name="password" autoComplete="current-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <button className="btn btn-primary w-full" type="submit" disabled={status.kind === 'busy' || password.length === 0}>
        Sign in
      </button>
      <StatusLine status={status} />
    </form>
  );
}
