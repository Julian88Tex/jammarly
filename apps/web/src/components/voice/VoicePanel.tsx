'use client';

import type { LearningRunResponse } from '@jammarly/shared/api';
import { cloneData } from '@jammarly/shared/merge';
import { emptyVoiceProfile, type ProfileDocument, type VoiceContext, type VoiceProfile, type VoiceSettings } from '@jammarly/shared/profile';
import { useState } from 'react';
import { api, describeError, formatDate, ops, sendOps } from '../api-client';
import { StatusLine, idle, type Status } from '../StatusLine';
import { Badge, Card, Empty, Field } from '../ui';

const CONTEXTS: { ctx: VoiceContext; label: string; hint: string }[] = [
  { ctx: 'messages', label: 'Messages', hint: 'email, chat, social' },
  { ctx: 'documents', label: 'Documents', hint: 'docs and everything else' },
];

function linesToList(text: string): string[] {
  return [...new Set(text.split(/\n|,/).map((s) => s.trim()).filter((s) => s.length > 0))].slice(0, 100);
}

function ContextEditor({ ctx, initial, baseVersion, onSaved }: { ctx: VoiceContext; initial: VoiceProfile | undefined; baseVersion: number; onSaved: (v: number) => void }) {
  const [profile, setProfile] = useState<VoiceProfile>(initial ?? emptyVoiceProfile(ctx));
  const [removed, setRemoved] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>(idle);
  const [runStatus, setRunStatus] = useState<Status>(idle);
  const exists = initial !== undefined && initial.generatedAt.length > 0;

  function update(patch: Partial<VoiceProfile>) {
    setProfile({ ...profile, ...patch });
  }

  function toggleLock(id: string) {
    update({ traits: profile.traits.map((t) => (t.id === id ? { ...t, locked: !t.locked } : t)) });
  }

  function removeTrait(id: string) {
    update({ traits: profile.traits.filter((t) => t.id !== id) });
    setRemoved([...removed, id]);
  }

  async function save() {
    setStatus({ kind: 'busy' });
    try {
      const next = cloneData(profile);
      next.version = (initial?.version ?? 0) + 1;
      next.generatedAt = new Date().toISOString();
      next.generatedBy = 'owner';
      next.removedByUser = [...new Set([...next.removedByUser, ...removed])].slice(0, 200);
      next.changelog = 'Edited on the dashboard.';
      const res = await sendOps([ops.voice(ctx, next)], baseVersion);
      const stored = res.profile.voice.profiles[ctx];
      if (stored !== undefined) setProfile(stored);
      setRemoved([]);
      onSaved(res.version);
      setStatus({ kind: 'ok', text: `Saved voice profile version ${next.version}.` });
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) });
    }
  }

  async function regenerate() {
    setRunStatus({ kind: 'busy', text: 'Starting…' });
    try {
      const res = await api<LearningRunResponse>('/api/learning/run', { body: { contexts: [ctx] } });
      setRunStatus(
        res.started
          ? { kind: 'ok', text: `Synthesis started (run ${res.runId ?? ''}). Check the Learning page for the result in a minute or two.` }
          : { kind: 'error', text: `Not started: ${res.reason ?? 'unknown reason'}.` },
      );
    } catch (err) {
      setRunStatus({ kind: 'error', text: describeError(err) });
    }
  }

  return (
    <Card
      title={CONTEXTS.find((c) => c.ctx === ctx)?.label ?? ctx}
      description={CONTEXTS.find((c) => c.ctx === ctx)?.hint}
      actions={
        <>
          {exists && <Badge tone="brand">v{profile.version} · {profile.confidence}</Badge>}
          <button type="button" className="btn btn-secondary btn-sm" onClick={regenerate}>
            Regenerate now
          </button>
        </>
      }
    >
      {!exists && profile.summary.length === 0 ? (
        <Empty>No profile for {ctx} yet. It is synthesized nightly once enough typed sentences and decisions arrive, or when you press Regenerate now.</Empty>
      ) : null}
      <div className="space-y-4">
        <p className="text-[12.5px] text-muted">
          Generated {formatDate(profile.generatedAt)} by <span className="font-mono">{profile.generatedBy || '—'}</span>
        </p>
        <Field label="Summary">
          <textarea className="field min-h-16" maxLength={2000} value={profile.summary} onChange={(e) => update({ summary: e.target.value })} />
        </Field>
        <div>
          <div className="mb-1 font-medium">Traits</div>
          {profile.traits.length === 0 ? (
            <p className="text-muted">No traits yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {profile.traits.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 px-3 py-2">
                  <div>
                    <div className="font-medium">
                      {t.label} <Badge>{t.dimension.replace(/_/g, ' ')}</Badge> <Badge tone={t.confidence === 'high' ? 'brand' : 'neutral'}>{t.confidence} · {t.evidenceCount}</Badge>
                    </div>
                    <div className="text-muted">{t.description}</div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" className={`btn btn-sm ${t.locked ? 'btn-primary' : 'btn-secondary'}`} onClick={() => toggleLock(t.id)} aria-pressed={t.locked}>
                      {t.locked ? 'Locked' : 'Lock'}
                    </button>
                    <button type="button" className="btn btn-danger btn-sm" onClick={() => removeTrait(t.id)}>
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Field label="Style guide" hint="Prose the editor model reads before suggesting. It cannot relax spelling or grammar; the lint rejects attempts.">
          <textarea className="field min-h-40 font-mono text-[12.5px]" maxLength={4000} value={profile.styleGuide} onChange={(e) => update({ styleGuide: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Keep phrases" hint="One per line.">
            <textarea className="field min-h-20" value={profile.keepPhrases.join('\n')} onChange={(e) => update({ keepPhrases: linesToList(e.target.value) })} />
          </Field>
          <Field label="Avoid phrases" hint="One per line.">
            <textarea className="field min-h-20" value={profile.avoidPhrases.join('\n')} onChange={(e) => update({ avoidPhrases: linesToList(e.target.value) })} />
          </Field>
          <Field label="Greetings">
            <textarea className="field min-h-16" value={profile.greetings.join('\n')} onChange={(e) => update({ greetings: linesToList(e.target.value).slice(0, 20) })} />
          </Field>
          <Field label="Sign-offs">
            <textarea className="field min-h-16" value={profile.signoffs.join('\n')} onChange={(e) => update({ signoffs: linesToList(e.target.value).slice(0, 20) })} />
          </Field>
        </div>
        {(profile.examples.accepted.length > 0 || profile.examples.rejected.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="mb-1 font-medium">Rewrites you accepted</div>
              <ul className="space-y-1 text-[13px]">
                {profile.examples.accepted.map((ex, i) => (
                  <li key={i} className="rounded border border-line px-2 py-1">
                    <span className="text-muted line-through">{ex.before}</span> → <span className="font-medium">{ex.after}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 font-medium">Rewrites you rejected</div>
              <ul className="space-y-1 text-[13px]">
                {profile.examples.rejected.map((ex, i) => (
                  <li key={i} className="rounded border border-line px-2 py-1">
                    <span className="text-muted">proposed “{ex.proposed}”</span> · kept <span className="font-medium">{ex.keptOrFinal}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={save}>
            Save {ctx} profile
          </button>
          <StatusLine status={status} />
        </div>
        <StatusLine status={runStatus} />
      </div>
    </Card>
  );
}

export function VoicePanel({ voice, history, version }: { voice: ProfileDocument['voice']; history: ProfileDocument['learning']['history']; version: number }) {
  const [base, setBase] = useState(version);
  const [settings, setSettings] = useState<VoiceSettings>(voice.settings.value);
  const [status, setStatus] = useState<Status>(idle);

  async function saveSettings() {
    setStatus({ kind: 'busy' });
    try {
      const res = await sendOps([ops.set('voice.settings', settings)], base);
      setBase(res.version);
      setStatus({ kind: 'ok', text: `Saved. Profile version ${res.version}.` });
    } catch (err) {
      setStatus({ kind: 'error', text: describeError(err) });
    }
  }

  return (
    <div className="space-y-4">
      <Card title="Strength and notes" description="0 turns the voice block off; 1 words rewrites only; 2 also recognizes intentional style; 3 may propose voice-alignment rewrites.">
        <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
          <Field label={`Strength: ${settings.strength}`}>
            <input type="range" min={0} max={3} step={1} className="w-full accent-brand" value={settings.strength} onChange={(e) => setSettings({ ...settings, strength: Number(e.target.value) as VoiceSettings['strength'] })} />
            <div className="flex justify-between text-[12px] text-muted">
              <span>off</span>
              <span>wording</span>
              <span>default</span>
              <span>rewrites</span>
            </div>
          </Field>
          <Field label="Your notes" hint="Appended to the voice block where they do not conflict with the correctness contract (max 2,000 characters).">
            <textarea className="field min-h-20" maxLength={2000} value={settings.notes} onChange={(e) => setSettings({ ...settings, notes: e.target.value })} />
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={saveSettings}>
            Save settings
          </button>
          <StatusLine status={status} />
        </div>
      </Card>
      {CONTEXTS.map((c) => (
        <ContextEditor key={c.ctx} ctx={c.ctx} initial={voice.profiles[c.ctx]} baseVersion={base} onSaved={setBase} />
      ))}
      <Card title="History" description="What each synthesis changed, newest first.">
        {history.length === 0 ? (
          <Empty>No synthesis has run yet.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {[...history].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`} className="py-2">
                <div className="text-[12.5px] text-muted">
                  {formatDate(h.at)} · <span className="font-mono">{h.model}</span> · v{h.version} · {h.eventsSeen} events
                </div>
                <div>{h.changelog}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
