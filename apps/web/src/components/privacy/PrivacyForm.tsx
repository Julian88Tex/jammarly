'use client';

import type { ExportResponse, LearningDataDeleteResponse } from '@jammarly/shared/api';
import type { PrivacySettings } from '@jammarly/shared/profile';
import { useState } from 'react';
import { api, describeError, formatDate, ops, sendOps } from '../api-client';
import { StatusLine, idle, type Status } from '../StatusLine';
import { Card, Field } from '../ui';

const RETENTION: PrivacySettings['retentionDays'][] = [30, 90, 365];

export function PrivacyForm({ privacy, privateSites, version }: { privacy: PrivacySettings; privateSites: string[]; version: number }) {
  const [base, setBase] = useState(version);
  const [settings, setSettings] = useState(privacy);
  const [sites, setSites] = useState(privateSites.join('\n'));
  const [status, setStatus] = useState<Status>(idle);
  const [dataStatus, setDataStatus] = useState<Status>(idle);

  async function save() {
    setStatus({ kind: 'busy' });
    try {
      const list = [...new Set(sites.split('\n').map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter((s) => s.length > 0))];
      const res = await sendOps([ops.set('settings.privacy', settings), ops.set('settings.privateSites', list)], base);
      setBase(res.version);
      setSites(res.profile.settings.privateSites.value.join('\n'));
      setStatus({ kind: 'ok', text: `Saved. Devices pick this up on their next poll; the server enforces snippet storage on every upload.` });
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) });
    }
  }

  async function exportJson() {
    setDataStatus({ kind: 'busy', text: 'Preparing export…' });
    try {
      const data = await api<ExportResponse>('/api/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jammarly-export-${data.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDataStatus({ kind: 'ok', text: `Exported ${data.events.length} events, ${data.samples.length} samples and ${data.devices.length} devices.` });
    } catch (err) {
      setDataStatus({ kind: 'error', text: describeError(err) });
    }
  }

  async function deleteAll() {
    if (!window.confirm('Delete every event, sample, snapshot, run log, learned dictionary candidate and voice profile on the server? Your settings and dictionary stay. This cannot be undone.')) return;
    setDataStatus({ kind: 'busy', text: 'Deleting…' });
    try {
      const res = await api<LearningDataDeleteResponse>('/api/learning/data', { method: 'DELETE' });
      setDataStatus({ kind: 'ok', text: `Deleted ${res.deleted.events} event batches, ${res.deleted.samples} sample batches, ${res.deleted.snapshots} snapshots and ${res.deleted.runs} run logs. Voice profiles and learned counters were reset.` });
    } catch (err) {
      setDataStatus({ kind: 'error', text: describeError(err) });
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="What is stored" description="Counters are always kept; snippets are the only text that leaves a device.">
        <div className="space-y-3">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-brand" checked={settings.storeSnippets} onChange={(e) => setSettings({ ...settings, storeSnippets: e.target.checked })} />
            <span>
              <span className="font-medium">Store snippets</span>
              <span className="block text-muted">Redacted original / replacement text (≤ 200 characters) and typed sentences for voice synthesis. Off: the server strips them from every upload regardless of the device.</span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-4 w-4 accent-brand" checked={settings.learningEnabled} onChange={(e) => setSettings({ ...settings, learningEnabled: e.target.checked })} />
            <span>
              <span className="font-medium">Learning enabled</span>
              <span className="block text-muted">Fold accepts and dismissals into rule states and synthesize the voice profile nightly.</span>
            </span>
          </label>
          <Field label="Retention" hint="Raw events and samples older than this are deleted by the nightly job.">
            <select className="field w-auto" value={settings.retentionDays} onChange={(e) => setSettings({ ...settings, retentionDays: Number(e.target.value) as PrivacySettings['retentionDays'] })}>
              {RETENTION.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </Field>
          <p className="text-muted">
            Consent recorded: <span className="font-medium text-ink">{settings.consentAt === null ? 'not yet (the extension records it on first run)' : formatDate(settings.consentAt)}</span>
          </p>
        </div>
      </Card>

      <Card title="Private sites" description="Hosts where snippets are never stored (suffix match: google.com covers mail.google.com).">
        <textarea className="field min-h-40 font-mono text-[12.5px]" value={sites} onChange={(e) => setSites(e.target.value)} placeholder={'bank.example\nhealth.example'} aria-label="Private sites, one per line" />
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={save}>
            Save privacy settings
          </button>
        </div>
        <div className="mt-3">
          <StatusLine status={status} />
        </div>
      </Card>

      <Card title="Your data" description="Export everything the server holds, or delete the learning data." className="lg:col-span-2">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary" onClick={exportJson}>
            Export JSON
          </button>
          <button type="button" className="btn btn-danger" onClick={deleteAll}>
            Delete all learning data
          </button>
        </div>
        <p className="mt-2 text-[12.5px] text-muted">The export contains the profile document, the device list (no tokens), every retained event batch and every voice sample. Deleting keeps your settings, dictionary, muted rules and devices.</p>
        <div className="mt-3">
          <StatusLine status={dataStatus} />
        </div>
      </Card>
    </div>
  );
}
