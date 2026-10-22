'use client';

import { Notice } from './ui';

export type Status = { kind: 'idle' } | { kind: 'busy'; text?: string } | { kind: 'ok'; text: string } | { kind: 'error'; text: string };

export const idle: Status = { kind: 'idle' };

/** Inline success / error line shown under a form section. */
export function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'idle') return null;
  if (status.kind === 'busy') return <p className="text-muted">{status.text ?? 'Saving…'}</p>;
  return <Notice tone={status.kind === 'ok' ? 'brand' : 'danger'}>{status.text}</Notice>;
}
