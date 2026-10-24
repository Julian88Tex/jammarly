'use client';

import type { ServerKeyStatusResponse } from '@jammarly/shared/api';
import { decodeMute } from '@jammarly/shared/learner';
import { orSetLive } from '@jammarly/shared/merge';
import type { ProfileDocument, ProfileOp, SiteOverride } from '@jammarly/shared/profile';
import type { Dialect, SuggestionCategory, WritingContext, WritingGoals } from '@jammarly/shared/types';
import { useState, type FormEvent } from 'react';
import { api, describeError, ops, sendOps } from '../api-client';
import { StatusLine, idle, type Status } from '../StatusLine';
import { Badge, Card, Empty, Field } from '../ui';

const AUDIENCES: WritingGoals['audience'][] = ['general', 'knowledgeable', 'expert'];
const FORMALITIES: WritingGoals['formality'][] = ['informal', 'neutral', 'formal'];
const DOMAINS: WritingGoals['domain'][] = ['general', 'academic', 'business', 'email', 'casual', 'creative', 'technical'];
const INTENTS: WritingGoals['intent'][] = ['inform', 'describe', 'convince', 'tell_a_story'];
const DIALECTS: Dialect[] = ['en-US', 'en-GB', 'en-CA', 'en-AU', 'en-IN'];
const CONTEXTS: WritingContext[] = ['email', 'chat', 'doc', 'social', 'code', 'other'];
const CATEGORIES: SuggestionCategory[] = ['correctness', 'clarity', 'engagement', 'delivery'];
const MODES: ProfileDocument['settings']['mode']['value'][] = ['hybrid', 'quality', 'economy'];

function Select<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: readonly T[]; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <select className="field" value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
}

export function TuningForm({ profile, version, serverKey }: { profile: ProfileDocument; version: number; serverKey: ServerKeyStatusResponse }) {
  const [base, setBase] = useState(version);
  const s = profile.settings;
  const [goals, setGoals] = useState<WritingGoals>(s.goals.value);
  const [dialect, setDialect] = useState<Dialect>(s.dialect.value);
  const [categories, setCategories] = useState(s.categories.value);
  const [instructions, setInstructions] = useState(s.customInstructions.value);
  const [mode, setMode] = useState(s.mode.value);
  const [model, setModel] = useState(s.model.value);
  const [fastModel, setFastModel] = useState(s.fastModel.value);
  const [dictionary, setDictionary] = useState<string[]>(orSetLive(profile.dictionary));
  const [newWord, setNewWord] = useState('');
  const [muted, setMuted] = useState<string[]>(orSetLive(profile.rules.muted));
  const [overrides, setOverrides] = useState<Record<string, SiteOverride>>(Object.fromEntries(Object.entries(profile.sites.overrides).map(([h, v]) => [h, v.value])));
  const [newHost, setNewHost] = useState('');
  const [keyStatus, setKeyStatus] = useState(serverKey);
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState<Record<string, Status>>({});

  const set = (section: string, st: Status) => setStatus((prev) => ({ ...prev, [section]: st }));

  async function push(section: string, list: ProfileOp[], okText = 'Saved.') {
    set(section, { kind: 'busy' });
    try {
      const res = await sendOps(list, base);
      setBase(res.version);
      setDictionary(orSetLive(res.profile.dictionary));
      setMuted(orSetLive(res.profile.rules.muted));
      set(section, { kind: 'ok', text: `${okText} Profile version ${res.version}.` });
    } catch (err) {
      set(section, { kind: 'error', text: describeError(err) });
    }
  }

  function saveGoals(e: FormEvent) {
    e.preventDefault();
    void push('goals', [ops.set('settings.goals', goals), ops.set('settings.dialect', dialect), ops.set('settings.categories', categories), ops.set('settings.customInstructions', instructions)]);
  }

  function saveModels(e: FormEvent) {
    e.preventDefault();
    void push('models', [ops.set('settings.mode', mode), ops.set('settings.model', model.trim()), ops.set('settings.fastModel', fastModel.trim())]);
  }

  function addWord(e: FormEvent) {
    e.preventDefault();
    const w = newWord.trim();
    if (w.length === 0) return;
    setNewWord('');
    void push('dictionary', [ops.add('dictionary', w)], `Added “${w}”.`);
  }

  function saveOverride(host: string) {
    const value = overrides[host] ?? {};
    void push('overrides', [ops.set(`sites.overrides.${host}`, value)], `Saved overrides for ${host}.`);
  }

  function addOverride(e: FormEvent) {
    e.preventDefault();
    const host = newHost.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host.length === 0 || overrides[host] !== undefined) return;
    setOverrides({ ...overrides, [host]: {} });
    setNewHost('');
  }

  function clearOverride(host: string) {
    const next = { ...overrides };
    delete next[host];
    setOverrides(next);
    void push('overrides', [ops.set(`sites.overrides.${host}`, {})], `Cleared overrides for ${host}.`);
  }

  async function saveKey(e: FormEvent) {
    e.preventDefault();
    set('key', { kind: 'busy' });
    try {
      const st = await api<ServerKeyStatusResponse>('/api/server-key', { method: 'PUT', body: { apiKey: apiKey.trim() } });
      setKeyStatus(st);
      setApiKey('');
      set('key', { kind: 'ok', text: 'Server key stored (encrypted).' });
    } catch (err) {
      set('key', { kind: 'error', text: describeError(err) });
    }
  }

  async function clearKey() {
    set('key', { kind: 'busy' });
    try {
      setKeyStatus(await api<ServerKeyStatusResponse>('/api/server-key', { method: 'DELETE' }));
      set('key', { kind: 'ok', text: 'Stored key removed.' });
    } catch (err) {
      set('key', { kind: 'error', text: describeError(err) });
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Goals" description="Defaults for every site; override them per site below." className="lg:col-span-2">
        <form onSubmit={saveGoals} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Audience">
              <Select value={goals.audience} options={AUDIENCES} onChange={(audience) => setGoals({ ...goals, audience })} />
            </Field>
            <Field label="Formality">
              <Select value={goals.formality} options={FORMALITIES} onChange={(formality) => setGoals({ ...goals, formality })} />
            </Field>
            <Field label="Domain">
              <Select value={goals.domain} options={DOMAINS} onChange={(domain) => setGoals({ ...goals, domain })} />
            </Field>
            <Field label="Intent">
              <Select value={goals.intent} options={INTENTS} onChange={(intent) => setGoals({ ...goals, intent })} />
            </Field>
            <Field label="Dialect">
              <Select value={dialect} options={DIALECTS} onChange={setDialect} />
            </Field>
          </div>
          <fieldset>
            <legend className="mb-1 font-medium">Categories</legend>
            <div className="flex flex-wrap gap-4">
              {CATEGORIES.map((c) => (
                <label key={c} className="inline-flex items-center gap-2">
                  <input type="checkbox" className="h-4 w-4 accent-brand" checked={categories[c]} onChange={(e) => setCategories({ ...categories, [c]: e.target.checked })} />
                  <span className={`inline-block h-2.5 w-2.5 rounded-full bg-${c}`} aria-hidden="true" />
                  {c}
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Custom instructions" hint="Plain-language guidance appended to every check (max 4,000 characters). Style only; it cannot relax correctness.">
            <textarea className="field min-h-24" maxLength={4000} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
          </Field>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary">
              Save goals
            </button>
            <StatusLine status={status['goals'] ?? idle} />
          </div>
        </form>
      </Card>

      <Card title="Per-site overrides" description="Context, goals and categories for one host. Missing fields fall back to the defaults.">
        <form onSubmit={addOverride} className="mb-3 flex gap-2">
          <input className="field" placeholder="mail.google.com" value={newHost} onChange={(e) => setNewHost(e.target.value)} aria-label="Host to override" />
          <button type="submit" className="btn btn-secondary">
            Add
          </button>
        </form>
        {Object.keys(overrides).length === 0 ? (
          <Empty>No overrides.</Empty>
        ) : (
          <div className="space-y-3">
            {Object.entries(overrides).map(([host, o]) => (
              <div key={host} className="rounded-md border border-line p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono font-medium">{host}</span>
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => clearOverride(host)}>
                    Clear
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Context">
                    <Select<WritingContext | 'default'>
                      value={o.context ?? 'default'}
                      options={['default', ...CONTEXTS]}
                      onChange={(v) => setOverrides({ ...overrides, [host]: v === 'default' ? { ...o, context: undefined } : { ...o, context: v } })}
                    />
                  </Field>
                  <Field label="Formality">
                    <Select<WritingGoals['formality'] | 'default'>
                      value={o.goals?.formality ?? 'default'}
                      options={['default', ...FORMALITIES]}
                      onChange={(v) => setOverrides({ ...overrides, [host]: { ...o, goals: v === 'default' ? { ...o.goals, formality: undefined } : { ...o.goals, formality: v } } })}
                    />
                  </Field>
                </div>
                <div className="mt-2 flex flex-wrap gap-3">
                  {CATEGORIES.map((c) => (
                    <label key={c} className="inline-flex items-center gap-1.5 text-[13px]">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-brand"
                        checked={o.categories?.[c] ?? categories[c]}
                        onChange={(e) => setOverrides({ ...overrides, [host]: { ...o, categories: { ...o.categories, [c]: e.target.checked } } })}
                      />
                      {c}
                    </label>
                  ))}
                </div>
                <button type="button" className="btn btn-primary btn-sm mt-2" onClick={() => saveOverride(host)}>
                  Save {host}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-3">
          <StatusLine status={status['overrides'] ?? idle} />
        </div>
      </Card>

      <Card title="Models and engine mode" description="Hybrid runs a fast pass and a deep pass; quality uses only the deep model; economy only the fast one.">
        <form onSubmit={saveModels} className="space-y-3">
          <Field label="Mode">
            <Select value={mode} options={MODES} onChange={setMode} />
          </Field>
          <Field label="Deep model id">
            <input className="field font-mono" value={model} onChange={(e) => setModel(e.target.value)} pattern="[A-Za-z0-9._:-]+" required />
          </Field>
          <Field label="Fast model id">
            <input className="field font-mono" value={fastModel} onChange={(e) => setFastModel(e.target.value)} pattern="[A-Za-z0-9._:-]+" required />
          </Field>
          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary">
              Save models
            </button>
            <StatusLine status={status['models'] ?? idle} />
          </div>
        </form>
      </Card>

      <Card title="Dictionary" description="Words Jammarly never flags as misspelled.">
        <form onSubmit={addWord} className="mb-3 flex gap-2">
          <input className="field" placeholder="Add a word" value={newWord} maxLength={100} onChange={(e) => setNewWord(e.target.value)} aria-label="Word to add" />
          <button type="submit" className="btn btn-secondary">
            Add
          </button>
        </form>
        {dictionary.length === 0 ? (
          <Empty>No words yet.</Empty>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {dictionary.map((w) => (
              <li key={w} className="inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2.5 py-0.5">
                {w}
                <button type="button" className="text-muted hover:text-danger" aria-label={`Remove ${w}`} onClick={() => push('dictionary', [ops.remove('dictionary', w)], `Removed “${w}”.`)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <StatusLine status={status['dictionary'] ?? idle} />
        </div>
      </Card>

      <Card title="Muted rules" description="Suggestion types you turned off from a hover card, everywhere or on one site.">
        {muted.length === 0 ? (
          <Empty>Nothing muted.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {muted.map((entry) => {
              const m = decodeMute(entry);
              return (
                <li key={entry} className="flex items-center justify-between py-1.5">
                  <span>
                    <span className="font-mono">{m.rule}</span> {m.host !== undefined ? <Badge>on {m.host}</Badge> : <Badge tone="warn">everywhere</Badge>}
                  </span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => push('muted', [ops.remove('rules.muted', entry)], `Unmuted ${m.rule}.`)}>
                    Unmute
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3">
          <StatusLine status={status['muted'] ?? idle} />
        </div>
      </Card>

      <Card title="Server key for the learning job" description="Used only by the nightly voice synthesis on the server. Devices never receive it.">
        <p className="mb-3">
          Status:{' '}
          {keyStatus.configured ? (
            <Badge tone="brand">configured · ends in {keyStatus.hint}</Badge>
          ) : (
            <Badge tone="warn">not configured</Badge>
          )}
        </p>
        <form onSubmit={saveKey} className="flex gap-2">
          <input className="field font-mono" type="password" placeholder="sk-ant-…" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} aria-label="Anthropic API key" />
          <button type="submit" className="btn btn-primary" disabled={apiKey.trim().length < 20}>
            Save
          </button>
          <button type="button" className="btn btn-danger" onClick={clearKey} disabled={!keyStatus.configured}>
            Clear
          </button>
        </form>
        <p className="mt-2 text-[12.5px] text-muted">Stored AES-256-GCM encrypted with a key derived from SESSION_SECRET. An ANTHROPIC_API_KEY environment variable is used when no key is stored here.</p>
        <div className="mt-3">
          <StatusLine status={status['key'] ?? idle} />
        </div>
      </Card>
    </div>
  );
}
