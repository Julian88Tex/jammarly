'use client';

import type { DeviceInfo, DevicesListResponse, ExternalPairMessage, ExternalPairReply, PairStartResponse } from '@jammarly/shared/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError, relativeTime } from '../api-client';
import { StatusLine, idle, type Status } from '../StatusLine';
import { Badge, Card, Empty } from '../ui';

interface ChromeRuntimeLike {
  runtime?: { sendMessage?: (extensionId: string, message: unknown, callback: (reply: unknown) => void) => void; lastError?: { message?: string } };
}

type PairState = { kind: 'idle' } | { kind: 'starting' } | { kind: 'code'; pairing: PairStartResponse; viaExtension: 'trying' | 'paired' | 'manual' };

export function DevicesPanel({ initialDevices, extensionIds, appOrigin }: { initialDevices: DeviceInfo[]; extensionIds: string[]; appOrigin: string }) {
  const [devices, setDevices] = useState(initialDevices);
  const [status, setStatus] = useState<Status>(idle);
  const [pair, setPair] = useState<PairState>({ kind: 'idle' });
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const list = await api<DevicesListResponse>('/api/devices');
    setDevices(list.devices);
    return list.devices;
  }, []);

  useEffect(() => () => {
    if (pollTimer.current !== null) clearInterval(pollTimer.current);
  }, []);

  async function revoke(id: string) {
    if (!window.confirm('Unpair this device? It will stop syncing until paired again.')) return;
    setStatus({ kind: 'busy' });
    try {
      await api(`/api/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
      await refresh();
      setStatus({ kind: 'ok', text: 'Device unpaired.' });
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) });
    }
  }

  function trySendToExtensions(pairing: PairStartResponse): void {
    const chrome = (globalThis as { chrome?: ChromeRuntimeLike }).chrome;
    const send = chrome?.runtime?.sendMessage;
    if (send === undefined || extensionIds.length === 0) {
      setPair({ kind: 'code', pairing, viaExtension: 'manual' });
      return;
    }
    let pending = extensionIds.length;
    let paired = false;
    const message: ExternalPairMessage = { type: 'jammarly.pair', pairingId: pairing.pairingId, code: pairing.code, appOrigin };
    for (const id of extensionIds) {
      try {
        send(id, message, (reply: unknown) => {
          pending -= 1;
          const r = reply as ExternalPairReply | undefined;
          if (r?.ok === true) {
            paired = true;
            setPair({ kind: 'code', pairing, viaExtension: 'paired' });
            void refresh();
          } else if (pending === 0 && !paired) {
            setPair({ kind: 'code', pairing, viaExtension: 'manual' });
          }
        });
      } catch {
        pending -= 1;
        if (pending === 0 && !paired) setPair({ kind: 'code', pairing, viaExtension: 'manual' });
      }
    }
    // Chrome never calls back when the extension is not installed: fall back after a short wait.
    setTimeout(() => {
      if (!paired) setPair((p) => (p.kind === 'code' && p.viaExtension === 'trying' ? { ...p, viaExtension: 'manual' } : p));
    }, 2500);
  }

  async function startPairing() {
    setPair({ kind: 'starting' });
    setStatus(idle);
    try {
      const pairing = await api<PairStartResponse>('/api/devices/pair/start', { method: 'POST' });
      setPair({ kind: 'code', pairing, viaExtension: 'trying' });
      trySendToExtensions(pairing);
      // Poll the device list while the code is valid so a manual redeem shows up.
      if (pollTimer.current !== null) clearInterval(pollTimer.current);
      const before = devices.length;
      pollTimer.current = setInterval(async () => {
        const list = await refresh().catch(() => null);
        if (list !== null && list.length > before) {
          if (pollTimer.current !== null) clearInterval(pollTimer.current);
          setPair((p) => (p.kind === 'code' ? { ...p, viaExtension: 'paired' } : p));
        }
        if (Date.parse(pairing.expiresAt) < Date.now() && pollTimer.current !== null) clearInterval(pollTimer.current);
      }, 5000);
    } catch (err) {
      setPair({ kind: 'idle' });
      setStatus({ kind: 'error', text: describeError(err) });
    }
  }

  return (
    <Card
      title="Devices"
      description="Each paired browser holds its own token; revoking stops it on its next request."
      actions={
        <button type="button" className="btn btn-primary btn-sm" onClick={startPairing} disabled={pair.kind === 'starting'}>
          Pair a device
        </button>
      }
    >
      {pair.kind === 'code' && (
        <div className="mb-4 rounded-md border border-accent/40 bg-accent/10 p-3">
          {pair.viaExtension === 'paired' ? (
            <p className="font-medium text-brand-strong dark:text-brand">Paired. The extension will start syncing within a few seconds.</p>
          ) : (
            <>
              <p className="font-medium">
                Pairing code <span className="ml-1 rounded bg-panel px-2 py-0.5 font-mono text-lg tracking-widest">{pair.pairing.code}</span>
              </p>
              <p className="mt-1 text-muted">
                {pair.viaExtension === 'trying'
                  ? 'Asking the Jammarly extension in this browser to pair…'
                  : 'Type this code in the extension\'s options page (Pair with the web app). It expires in 10 minutes.'}
              </p>
            </>
          )}
          <button type="button" className="btn btn-secondary btn-sm mt-2" onClick={() => setPair({ kind: 'idle' })}>
            Done
          </button>
        </div>
      )}
      {devices.length === 0 ? (
        <Empty>No devices paired yet.</Empty>
      ) : (
        <table className="w-full text-left">
          <thead className="text-[12px] uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Device</th>
              <th className="py-1.5 pr-3 font-medium">Extension</th>
              <th className="py-1.5 pr-3 font-medium">Paired</th>
              <th className="py-1.5 pr-3 font-medium">Last seen</th>
              <th className="py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-t border-line">
                <td className="py-2 pr-3">
                  <div className="font-medium">{d.name}</div>
                  <div className="text-[12px] text-muted">
                    {d.platform} · <span className="font-mono">{d.id}</span>
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <Badge>v{d.extVersion}</Badge>
                </td>
                <td className="py-2 pr-3 text-muted">{relativeTime(d.createdAt)}</td>
                <td className="py-2 pr-3 text-muted">{relativeTime(d.lastSeenAt)}</td>
                <td className="py-2 text-right">
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => revoke(d.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-3">
        <StatusLine status={status} />
      </div>
    </Card>
  );
}
