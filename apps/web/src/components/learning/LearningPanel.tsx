'use client';

import type { LearningRunResponse, LearningRunStatus } from '@jammarly/shared/api';
import { encodeMute } from '@jammarly/shared/learner';
import type { LearningSummary, TrendValue } from '@jammarly/shared/learning';
import type { SuggestionCategory } from '@jammarly/shared/types';
import { useState } from 'react';
import { api, describeError, formatDate, ops, sendOps } from '../api-client';
import { StatusLine, idle, type Status } from '../StatusLine';
import { Badge, Card, Empty, Stat, percent, type Tone } from '../ui';

const CATEGORIES: SuggestionCategory[] = ['correctness', 'clarity', 'engagement', 'delivery'];

function Trend({ t }: { t: TrendValue }) {
  if (t.n === 0) return <span className="text-muted">—</span>;
  const delta = t.delta === 0 ? '' : t.delta > 0 ? ` ▲${percent(t.delta)}` : ` ▼${percent(-t.delta)}`;
  return (
    <span>
      <span className="font-medium">{percent(t.value)}</span>
      <span className="text-muted">
        {' '}
        [{percent(t.ciLow)}–{percent(t.ciHigh)}] n={t.n}
        {delta}
      </span>
    </span>
  );
}

const STATE_TONE: Record<string, Tone> = { active: 'brand', demoted: 'warn', suppressed: 'danger', probing: 'accent' };

export function LearningPanel({ summary, status, version }: { summary: LearningSummary; status: LearningRunStatus | null; version: number }) {
  const [base, setBase] = useState(version);
  const [rows, setRows] = useState(summary.byRule);
  const [muteStatus, setMuteStatus] = useState<Status>(idle);
  const [runStatus, setRunStatus] = useState<Status>(idle);
  const [latest, setLatest] = useState(status);
  const [filter, setFilter] = useState<'all' | 'adjusted'>('all');

  async function toggleMute(row: LearningSummary['byRule'][number]) {
    const entry = row.scope === 'host' ? encodeMute(row.rule, row.scopeKey) : encodeMute(row.rule);
    setMuteStatus({ kind: 'busy' });
    try {
      const res = await sendOps([row.manualOff ? ops.remove('rules.muted', entry) : ops.add('rules.muted', entry)], base);
      setBase(res.version);
      setRows(rows.map((r) => (r.rule === row.rule && r.scopeKey === row.scopeKey && r.scope === row.scope ? { ...r, manualOff: !row.manualOff } : r)));
      setMuteStatus({ kind: 'ok', text: `${row.manualOff ? 'Unmuted' : 'Muted'} ${row.rule}${row.scope === 'host' ? ` on ${row.scopeKey}` : ''}.` });
    } catch (err) {
      setMuteStatus({ kind: 'error', text: describeError(err) });
    }
  }

  async function runNow() {
    setRunStatus({ kind: 'busy', text: 'Starting…' });
    try {
      const res = await api<LearningRunResponse>('/api/learning/run', { body: {} });
      if (!res.started) {
        setRunStatus({ kind: 'error', text: `Not started: ${res.reason ?? 'unknown'}${res.reason === 'quota' ? ' (3 manual runs per day)' : ''}.` });
        return;
      }
      setRunStatus({ kind: 'ok', text: `Run ${res.runId ?? ''} started. Refreshing status…` });
      setTimeout(async () => {
        try {
          setLatest(await api<LearningRunStatus>('/api/learning/status'));
        } catch {
          // keep the previous status
        }
      }, 4000);
    } catch (err) {
      setRunStatus({ kind: 'error', text: describeError(err) });
    }
  }

  const shown = filter === 'all' ? rows : rows.filter((r) => r.state !== 'active' || r.eligibleForBulk || r.manualOff);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Acceptance" description={`${summary.window.from.slice(0, 10)} to ${summary.window.to.slice(0, 10)}, with 95 % Wilson intervals and the change against the previous window.`} className="lg:col-span-2">
          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Shown" value={summary.overall.shown} />
            <Stat label="Accepted" value={summary.overall.accepted} />
            <Stat label="Dismissed" value={summary.overall.dismissed} />
            <Stat label="Ignored" value={summary.overall.ignored} />
          </div>
          <table className="w-full text-left">
            <thead className="text-[12px] uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Category</th>
                <th className="py-1.5 pr-3 font-medium">Acceptance</th>
                <th className="py-1.5 pr-3 font-medium">Dismiss rate</th>
                <th className="py-1.5 font-medium">Per 100 words</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-line">
                <td className="py-1.5 pr-3 font-medium">overall</td>
                <td className="py-1.5 pr-3">
                  <Trend t={summary.overall.acceptance} />
                </td>
                <td className="py-1.5 pr-3">
                  <Trend t={summary.overall.dismissRate} />
                </td>
                <td className="py-1.5 text-muted">—</td>
              </tr>
              {CATEGORIES.map((c) => {
                const b = summary.byCategory[c];
                return (
                  <tr key={c} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      <span className={`mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-${c}`} aria-hidden="true" />
                      {c}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Trend t={b.acceptance} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <Trend t={b.dismissRate} />
                    </td>
                    <td className="py-1.5">{b.per100Words.n > 0 ? b.per100Words.value.toFixed(1) : <span className="text-muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        <Card
          title="Learning job"
          description="Runs nightly; Run now is the manual retry (3 per day)."
          actions={
            <button type="button" className="btn btn-primary btn-sm" onClick={runNow}>
              Run now
            </button>
          }
        >
          {latest === null ? (
            <Empty>No run yet.</Empty>
          ) : (
            <dl className="space-y-1">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Run</dt>
                <dd className="font-mono">{latest.runId}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Stage</dt>
                <dd>
                  <Badge tone={latest.stage === 'done' ? 'brand' : latest.stage === 'failed' ? 'danger' : latest.stage === 'partial' ? 'warn' : 'accent'}>{latest.stage}</Badge>
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Started</dt>
                <dd>{formatDate(latest.startedAt)}</dd>
              </div>
              {latest.finishedAt !== undefined && (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Finished</dt>
                  <dd>{formatDate(latest.finishedAt)}</dd>
                </div>
              )}
              {latest.message !== undefined && <p className="pt-1 text-muted">{latest.message}</p>}
            </dl>
          )}
          <div className="mt-3 space-y-1 text-[12.5px] text-muted">
            <div>
              {summary.learnedState.suppressed} suppressed · {summary.learnedState.demoted} demoted · {summary.learnedState.promoted} promoted · {summary.learnedState.manualOff} muted
            </div>
            <div>
              Dictionary: {summary.learnedState.dictionaryLearned} learned, {summary.learnedState.dictionaryManual} manual
              {summary.learnedState.dialectInferred !== undefined ? ` · dialect looks like ${summary.learnedState.dialectInferred}` : ''}
            </div>
          </div>
          <div className="mt-3">
            <StatusLine status={runStatus} />
          </div>
        </Card>
      </div>

      <Card
        title="Rules"
        description="State resolved by the learner per scope; promoted rules qualify for Accept all grammar at lower confidence. Mute is your manual override."
        actions={
          <select className="field w-auto" value={filter} onChange={(e) => setFilter(e.target.value as 'all' | 'adjusted')} aria-label="Filter rules">
            <option value="all">All rules</option>
            <option value="adjusted">Adjusted only</option>
          </select>
        }
      >
        {shown.length === 0 ? (
          <Empty>No rule has enough decisions yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-[12px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Rule</th>
                  <th className="py-1.5 pr-3 font-medium">Scope</th>
                  <th className="py-1.5 pr-3 font-medium">Accepted / dismissed</th>
                  <th className="py-1.5 pr-3 font-medium">Wilson</th>
                  <th className="py-1.5 pr-3 font-medium">State</th>
                  <th className="py-1.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={`${r.scope}|${r.scopeKey}|${r.rule}`} className="border-t border-line">
                    <td className="py-1.5 pr-3">
                      <span className="font-mono">{r.rule}</span> <span className={`ml-1 inline-block h-2 w-2 rounded-full bg-${r.category}`} aria-hidden="true" />
                    </td>
                    <td className="py-1.5 pr-3 text-muted">{r.scope === 'global' ? 'global' : `${r.scope}: ${r.scopeKey}`}</td>
                    <td className="py-1.5 pr-3">
                      {r.accepted} / {r.dismissed} <span className="text-muted">({r.shown} shown)</span>
                    </td>
                    <td className="py-1.5 pr-3 text-muted">
                      {percent(r.wilsonLB)}–{percent(r.wilsonUB)}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={STATE_TONE[r.state] ?? 'neutral'}>{r.state}</Badge> {r.eligibleForBulk && <Badge tone="accent">bulk</Badge>} {r.manualOff && <Badge tone="warn">muted</Badge>}
                    </td>
                    <td className="py-1.5 text-right">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => toggleMute(r)}>
                        {r.manualOff ? 'Unmute' : 'Mute'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3">
          <StatusLine status={muteStatus} />
        </div>
      </Card>

      <Card title="What Jammarly learned" description="From the learning history, newest first.">
        {summary.history.length === 0 ? (
          <Empty>Nothing yet. The first synthesis needs about 20 decisions or 1,500 typed words.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {[...summary.history].reverse().map((h, i) => (
              <li key={`${h.at}-${i}`} className="py-2">
                <div className="text-[12.5px] text-muted">
                  {formatDate(h.at)} · <span className="font-mono">{h.model}</span> · v{h.version}
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
