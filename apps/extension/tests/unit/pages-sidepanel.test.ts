import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApplyTransaction, CheckRequest, FieldState, PanelToWorker, Suggestion, SuggestionCategory } from '@jammarly/shared/types';
import { hashText, splitParagraphs } from '@jammarly/shared/text';
import { mountSidePanel, type SidePanelApp } from '../../src/pages/sidepanel/app';
import { applyLocally, buildScratchRequest } from '../../src/pages/sidepanel/scratch';
import { SCRATCH_FIELD_ID, tierCounts, showTone } from '../../src/pages/sidepanel/state';
import { errorCopy } from '../../src/pages/sidepanel/view';
import { flush, installChromeMock, type ChromeMock, type FakePort } from '../../src/pages/testing/chrome-mock';

let mock: ChromeMock;
let root: HTMLElement;
let app: SidePanelApp | null = null;

let seq = 0;
function sugg(partial: Partial<Suggestion> & { id: string }): Suggestion {
  seq += 1;
  return {
    category: 'correctness',
    rule: 'spelling',
    severity: 'error',
    kind: 'replace',
    source: 'llm',
    tier: 'A',
    anchor: 'exact',
    range: { start: 0, end: 5 },
    highlight: { start: 0, end: 5 },
    original: 'teh',
    replacement: 'the',
    alternatives: [],
    title: 'Correct the spelling',
    explanation: 'This looks like a typo.',
    confidence: 0.95,
    meaningPreserving: true,
    autoApplySafe: true,
    blockId: 'b0',
    blockHash: 'h0',
    conflictsWith: [],
    stale: false,
    promptVersion: '1',
    fingerprint: `fp-${seq}`,
    learnedState: 'active',
    ...partial,
  };
}

function field(partial: Partial<FieldState> = {}): FieldState {
  return {
    fieldId: 'f1',
    tabId: 7,
    frameId: 0,
    host: 'mail.google.com',
    fieldKind: 'contenteditable',
    label: 'Message body',
    version: 3,
    textPreview: 'Teh quick brown fox jumps over the lazy dog and keeps running.',
    wordCount: 12,
    suggestions: [],
    score: { overall: 86, wordCount: 12, readingTimeSeconds: 4 },
    status: 'suggestions',
    checkedBy: 'deep',
    active: true,
    undoAvailable: 0,
    transactions: [],
    ...partial,
  };
}

const TEXT = 'Teh quick brown fox jumps over the lazy dog and keeps running.';

function richField(): FieldState {
  const suggestions: Suggestion[] = [
    sugg({ id: 'sA', category: 'correctness', tier: 'A', range: { start: 0, end: 3 }, highlight: { start: 0, end: 3 }, original: 'Teh', replacement: 'The' }),
    sugg({ id: 'sA2', category: 'correctness', tier: 'A', rule: 'repeated_word', range: { start: 4, end: 9 }, highlight: { start: 4, end: 9 }, original: 'quick', replacement: 'quick ', title: 'Remove the repeated word' }),
    sugg({ id: 'sB', category: 'clarity', tier: 'B', rule: 'wordy_phrase', severity: 'suggestion', range: { start: 10, end: 15 }, highlight: { start: 10, end: 15 }, original: 'brown', replacement: 'tan', title: 'Shorten the wordy phrase', confidence: 0.8 }),
    sugg({ id: 'sB2', category: 'engagement', tier: 'B', rule: 'bland_word_choice', severity: 'suggestion', kind: 'delete', range: { start: 44, end: 49 }, highlight: { start: 44, end: 49 }, original: 'keeps', replacement: '', title: 'Choose a stronger word' }),
    sugg({ id: 'sC', category: 'delivery', tier: 'C', rule: 'tone_rewrite_confident', severity: 'suggestion', kind: 'rewrite', range: { start: 0, end: 62 }, highlight: { start: 0, end: 62 }, original: TEXT, replacement: 'The quick brown fox jumps over the lazy dog.', alternatives: ['A quick fox leaps over a lazy dog.', 'Fox jumps dog.'], title: 'Rewrite to sound more confident', confidence: 0.7, conflictsWith: ['sA'] }),
    sugg({ id: 'sStale', category: 'clarity', tier: 'C', rule: 'rewrite_for_clarity', kind: 'rewrite', stale: true, range: { start: 20, end: 43 }, highlight: { start: 20, end: 43 }, original: 'jumps over the lazy dog', replacement: 'leaps over the dog', title: 'Rewrite for clarity' }),
  ];
  const tx: ApplyTransaction = {
    id: 'tx1',
    fieldId: 'f1',
    at: new Date().toISOString(),
    edits: [],
    items: [
      { id: 'done1', title: 'Fix the article', category: 'correctness', original: 'a apple', replacement: 'an apple' },
      { id: 'done2', title: 'Use the active voice', category: 'clarity', original: 'was eaten by', replacement: 'ate' },
    ],
    appliedIds: ['done1', 'done2'],
    revertedIds: ['done2'],
  };
  return field({ suggestions, transactions: [tx], undoAvailable: 1 });
}

function port(): FakePort {
  return mock.ports[mock.ports.length - 1]!;
}

function sentActions(): PanelToWorker[] {
  return port().sent as PanelToWorker[];
}

function lastAction(): unknown {
  const msgs = sentActions().filter((m) => m.type === 'panel-action') as Extract<PanelToWorker, { type: 'panel-action' }>[];
  return msgs[msgs.length - 1]?.action;
}

async function mount(): Promise<SidePanelApp> {
  root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
  app = mountSidePanel(root, { usageRefreshMs: 0 });
  await app.ready;
  await flush();
  return app;
}

function showField(f: FieldState = richField()): void {
  port().emit({ type: 'fields', fields: [f] });
}

function card(id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`.jm-card[data-suggestion-id="${id}"]`);
  if (!el) throw new Error(`card ${id} not rendered`);
  return el;
}

function click(selector: string, within: ParentNode = root): void {
  const el = within.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

beforeEach(() => {
  mock = installChromeMock({ windowId: 11 });
});

afterEach(() => {
  app?.dispose();
  app = null;
  mock.restore();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('side panel: connection and fields', () => {
  it('connects, sends hello with the window id, fetches usage and renders the empty state with the scratch section', async () => {
    await mount();
    expect(port().name).toBe('jammarly-sidepanel');
    expect(port().sent).toContainEqual({ type: 'hello', role: 'sidepanel', windowId: 11 });
    expect(mock.requests.some((r) => r.type === 'get-usage')).toBe(true);
    expect(root.textContent).toContain('Focus a text field to see suggestions');
    expect(root.querySelector('.jm-scratch-input')).not.toBeNull();
    expect(root.querySelector('.jm-cost')?.textContent).toBe('Today $0.0123');
    expect(root.querySelector('[data-focus-key="footer:recheck"]')).not.toBeNull();
  });

  it('renders the active field, score, groups in category order with counts and tier chips', async () => {
    await mount();
    showField();
    expect(root.querySelector('.jm-field-label-text')?.textContent).toBe('Message body');
    expect(root.querySelector('.jm-field-host')?.textContent).toBe('mail.google.com');
    expect(root.querySelector('.jm-score-value')?.textContent).toBe('86');
    expect(root.textContent).toContain('12 words');
    const groups = Array.from(root.querySelectorAll<HTMLElement>('.jm-group[data-category]')).map((g) => g.dataset.category);
    expect(groups).toEqual(['correctness', 'clarity', 'engagement', 'delivery']);
    expect(root.querySelector('.jm-group-correctness .jm-group-count')?.textContent).toBe('2');
    expect(card('sA').querySelector('.jm-chip')?.textContent).toBe('Auto');
    expect(card('sC').querySelector('.jm-chip')?.textContent).toBe('Rewrite');
    expect(card('sStale').querySelector('.jm-chip')?.textContent).toBe('Sentence changed');
    expect(card('sB2').querySelector('.jm-remove')?.textContent).toBe('Remove');
    expect(card('sC').querySelectorAll('.jm-alternative').length).toBe(3);
  });

  it('shows tier counts on the three Accept-all buttons and the rewrite note', async () => {
    await mount();
    showField();
    const grammar = root.querySelector<HTMLButtonElement>('[data-group="grammar"]')!;
    const style = root.querySelector<HTMLButtonElement>('[data-group="style"]')!;
    const all = root.querySelector<HTMLButtonElement>('[data-group="all"]')!;
    expect(grammar.querySelector('.jm-count-badge')?.textContent).toBe('2');
    expect(style.querySelector('.jm-count-badge')?.textContent).toBe('2');
    expect(all.querySelector('.jm-count-badge')?.textContent).toBe('4');
    expect(root.querySelector('.jm-accept-note')?.textContent).toBe('2 rewrites need your choice');
    expect(tierCounts([])).toEqual({ grammar: 0, style: 0, all: 0, rewrites: 0 });
    port().emit({ type: 'field-state', state: field({ suggestions: [] , status: 'clean' }) });
    expect(root.querySelector<HTMLButtonElement>('[data-group="all"]')?.disabled).toBe(true);
    expect(root.querySelector('.jm-status')?.textContent).toContain('Looks good');
  });

  it('renders the recently applied list with revert state and "Undo all N"', async () => {
    await mount();
    showField();
    const items = root.querySelectorAll('.jm-applied-item');
    expect(items.length).toBe(2);
    expect(items[0]?.textContent).toContain('Fix the article');
    expect(items[1]?.classList.contains('is-reverted')).toBe(true);
    expect(root.querySelector('[data-focus-key="applied:undo"]')?.textContent).toContain('Undo all 1');
    click('[data-focus-key="revert:done1"]');
    expect(lastAction()).toEqual({ type: 'revert', fieldId: 'f1', suggestionId: 'done1' });
    click('[data-focus-key="applied:undo"]');
    expect(lastAction()).toEqual({ type: 'undo', fieldId: 'f1', transactionId: 'tx1' });
  });

  it('switches between fields with the select and returns to the empty state when fields are removed', async () => {
    await mount();
    const f2 = field({ fieldId: 'f2', label: 'Comment', host: 'github.com', active: false, suggestions: [sugg({ id: 'g1' })] });
    port().emit({ type: 'fields', fields: [richField(), f2] });
    const select = root.querySelector<HTMLSelectElement>('[data-focus-key="field-switcher"]')!;
    expect(select.options.length).toBe(3);
    expect(select.value).toBe('f1');
    select.value = 'f2';
    select.dispatchEvent(new Event('change'));
    expect(root.querySelector('.jm-group-correctness .jm-group-count')?.textContent).toBe('1');
    expect(card('g1')).toBeTruthy();
    port().emit({ type: 'field-removed', fieldId: 'f2' });
    expect(root.querySelector('.jm-field-label-text')?.textContent).toBe('Message body');
    port().emit({ type: 'field-removed', fieldId: 'f1' });
    expect(root.textContent).toContain('Focus a text field to see suggestions');
  });

  it('offers "Check text" next to a single field and comes back through the select', async () => {
    await mount();
    showField();
    expect(root.querySelector('select[data-focus-key="field-switcher"]')).toBeNull();
    click('button[data-focus-key="field-switcher"]');
    expect(root.querySelector('.jm-scratch-input')).not.toBeNull();
    expect(root.textContent).not.toContain('Focus a text field to see suggestions');
    const select = root.querySelector<HTMLSelectElement>('select[data-focus-key="field-switcher"]')!;
    expect(select.value).toBe(SCRATCH_FIELD_ID);
    select.value = 'f1';
    select.dispatchEvent(new Event('change'));
    expect(root.querySelector('.jm-field-label-text')?.textContent).toBe('Message body');
    // Flags have nothing to apply: Enter on a flag card sends nothing.
    port().emit({ type: 'field-state', state: field({ suggestions: [sugg({ id: 'flag1', kind: 'flag', tier: 'C', replacement: 'teh' })] }) });
    expect(card('flag1').querySelector('[data-focus-key="accept:flag1"]')).toBeNull();
    card('flag1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(lastAction()).toBeUndefined();
  });

  it('typing in the scratch textarea does not rebuild the panel until something visible changes', async () => {
    await mount();
    const area = root.querySelector<HTMLTextAreaElement>('.jm-scratch-input')!;
    const checkBtn = root.querySelector('[data-focus-key="scratch:check"]')!;
    area.value = 'a';
    area.dispatchEvent(new Event('input'));
    expect(root.querySelector('[data-focus-key="scratch:check"]')).not.toBe(checkBtn);
    const rebuilt = root.querySelector('[data-focus-key="scratch:check"]')!;
    area.value = 'ab';
    area.dispatchEvent(new Event('input'));
    expect(root.querySelector('[data-focus-key="scratch:check"]')).toBe(rebuilt);
    expect(app!.store.get().scratch.text).toBe('ab');
  });

  it('shows the tone chip only with >= 150 characters and a tone', async () => {
    await mount();
    const longText = 'x'.repeat(160);
    showField(field({ textPreview: longText, tone: { labels: [{ label: 'confident', strength: 'moderate' }], summary: 'Sounds confident.' } }));
    expect(root.querySelector('.jm-tone')?.textContent).toContain('Confident');
    expect(root.querySelector('.jm-tone-emoji')?.textContent).toBe('🤝');
    port().emit({ type: 'field-state', state: field({ textPreview: 'short', wordCount: 1, tone: { labels: [{ label: 'confident', strength: 'moderate' }], summary: '' } }) });
    expect(root.querySelector('.jm-tone')).toBeNull();
    expect(showTone({ tone: undefined, textPreview: longText, wordCount: 30 })).toBe(false);
    port().emit({ type: 'tone', fieldId: 'f1', version: 3, tone: { labels: [{ label: 'zesty', strength: 'slight' }], summary: '' } });
    port().emit({ type: 'field-state', state: field({ textPreview: longText, tone: { labels: [{ label: 'zesty', strength: 'slight' }], summary: '' } }) });
    expect(root.querySelector('.jm-tone-emoji')?.textContent).toBe('💬');
  });
});

describe('side panel: card actions send PanelActions', () => {
  it('accept, numbered alternative, dismiss, dismiss with reason and focus', async () => {
    await mount();
    showField();
    click('[data-focus-key="accept:sA"]');
    expect(lastAction()).toEqual({ type: 'accept', fieldId: 'f1', suggestionId: 'sA', alternativeIndex: undefined });
    click('[data-alternative="2"]', card('sC'));
    expect(lastAction()).toEqual({ type: 'accept', fieldId: 'f1', suggestionId: 'sC', alternativeIndex: 2 });
    click('.jm-replacement', card('sB'));
    expect(lastAction()).toMatchObject({ type: 'accept', suggestionId: 'sB' });
    click('[data-focus-key="dismiss:sB"]');
    expect(lastAction()).toEqual({ type: 'dismiss', fieldId: 'f1', suggestionId: 'sB', reason: undefined });
    click('[data-focus-key="dismiss-menu:sA2"]');
    expect(card('sA2').querySelector('.jm-menu[role=menu]')).not.toBeNull();
    click('[data-reason="meant_this"]', card('sA2'));
    expect(lastAction()).toEqual({ type: 'dismiss', fieldId: 'f1', suggestionId: 'sA2', reason: 'meant_this' });
    expect(root.querySelector('.jm-menu')).toBeNull();
    card('sB2').querySelector<HTMLElement>('.jm-card-title')!.click();
    expect(lastAction()).toEqual({ type: 'focus', fieldId: 'f1', suggestionId: 'sB2' });
  });

  it('add to dictionary (spelling only) and mute rule on this site / everywhere', async () => {
    await mount();
    showField();
    expect(card('sA').querySelector('[data-focus-key="dict:sA"]')).not.toBeNull();
    expect(card('sB').querySelector('[data-focus-key="dict:sB"]')).toBeNull();
    click('[data-focus-key="dict:sA"]');
    expect(sentActions()).toContainEqual({ type: 'add-to-dictionary', word: 'Teh' });
    click('[data-focus-key="more:sB"]');
    click('[data-mute="host"]', card('sB'));
    expect(sentActions()).toContainEqual({ type: 'mute-rule', rule: 'wordy_phrase', scope: 'host', host: 'mail.google.com' });
    click('[data-focus-key="more:sB2"]');
    click('[data-mute="global"]', card('sB2'));
    expect(sentActions()).toContainEqual({ type: 'mute-rule', rule: 'bland_word_choice', scope: 'global', host: undefined });
  });

  it('dismiss-all asks for an inline confirmation before sending', async () => {
    await mount();
    showField();
    click('[data-focus-key="dismiss-all:clarity"]');
    expect(lastAction()).toBeUndefined();
    expect(root.querySelector('.jm-group-clarity .jm-confirm')?.textContent).toContain('Dismiss all 2 clarity suggestions?');
    click('.jm-group-clarity .jm-confirm [data-focus-key="confirm:yes"]');
    expect(lastAction()).toEqual({ type: 'dismiss-all', fieldId: 'f1', category: 'clarity' });
    expect(root.querySelector('.jm-confirm')).toBeNull();
  });

  it('accept-all buttons send the group scope; "Check now" and the retry button send recheck', async () => {
    await mount();
    showField();
    click('[data-group="style"]');
    expect(lastAction()).toEqual({ type: 'accept-all', fieldId: 'f1', scope: { group: 'style' } });
    click('[data-group="all"]');
    expect(lastAction()).toEqual({ type: 'accept-all', fieldId: 'f1', scope: { group: 'all' } });
    click('[data-focus-key="footer:recheck"]');
    expect(lastAction()).toEqual({ type: 'recheck', fieldId: 'f1' });
  });

  it('the preview popover lists up to 8 rows, and Choose… sends the ticked suggestionIds', async () => {
    await mount();
    const many = Array.from({ length: 10 }, (_, i) => sugg({ id: `m${i}`, range: { start: i * 2, end: i * 2 + 1 }, highlight: { start: i * 2, end: i * 2 + 1 }, original: 'x', replacement: 'y' }));
    showField(field({ suggestions: many }));
    const grammar = root.querySelector<HTMLButtonElement>('[data-group="grammar"]')!;
    grammar.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    const preview = root.querySelector('#jm-preview')!;
    expect(preview.querySelectorAll('.jm-preview-row').length).toBe(8);
    expect(preview.querySelector('.jm-preview-more')?.textContent).toBe('+2 more');
    expect(preview.textContent).toContain('Accept all grammar will apply 10 changes');
    click('[data-focus-key="preview:choose"]');
    const boxes = root.querySelectorAll<HTMLInputElement>('#jm-preview input[type=checkbox]');
    expect(boxes.length).toBe(10);
    expect(Array.from(boxes).every((b) => b.checked)).toBe(true);
    boxes[0]!.click();
    // The checklist re-renders after every toggle, so re-query before the next click.
    root.querySelector<HTMLInputElement>('#jm-preview input[data-suggestion-id="m1"]')!.click();
    expect(root.querySelector<HTMLInputElement>('#jm-preview input[data-suggestion-id="m0"]')?.checked).toBe(false);
    expect(root.querySelector('[data-focus-key="preview:accept"]')?.textContent).toContain('Accept selected (8)');
    click('[data-focus-key="preview:accept"]');
    const action = lastAction() as { scope: { group: string; suggestionIds: string[] } };
    expect(action.scope.group).toBe('grammar');
    expect(action.scope.suggestionIds).toEqual(many.slice(2).map((s) => s.id));
    expect(root.querySelector('#jm-preview')).toBeNull();
  });

  it('the preview hides on mouse leave unless pinned with the chevron', async () => {
    await mount();
    showField();
    const bar = root.querySelector<HTMLElement>('.jm-accept-all')!;
    root.querySelector<HTMLButtonElement>('[data-group="grammar"]')!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(root.querySelector('#jm-preview')).not.toBeNull();
    bar.dispatchEvent(new MouseEvent('mouseleave'));
    expect(root.querySelector('#jm-preview')).toBeNull();
    click('.jm-accept-group .jm-accept-more');
    expect(root.querySelector('#jm-preview')).not.toBeNull();
    root.querySelector<HTMLElement>('.jm-accept-all')!.dispatchEvent(new MouseEvent('mouseleave'));
    expect(root.querySelector('#jm-preview')).not.toBeNull();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('#jm-preview')).toBeNull();
  });
});

describe('side panel: goals and categories', () => {
  it('the goals dialog sends set-goals with the host scope and a recheck', async () => {
    await mount();
    port().emit({ type: 'config', config: { goals: { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' }, categories: { correctness: true, clarity: true, engagement: true, delivery: true }, host: 'mail.google.com' }, settings: mock.settings, sync: null });
    showField();
    expect(root.querySelector('.jm-goals-summary')?.textContent).toBe('General · Neutral · General · Inform');
    click('[data-focus-key="goals"]');
    const dialog = root.querySelector('[role=dialog]')!;
    expect(dialog).not.toBeNull();
    click('[data-focus-key="goal:formality:formal"]', dialog);
    click('[data-focus-key="goal:domain:email"]', root.querySelector('[role=dialog]')!);
    click('[data-focus-key="goal:scope"]', root.querySelector('[role=dialog]')!);
    click('[data-focus-key="goal:done"]', root.querySelector('[role=dialog]')!);
    expect(sentActions()).toContainEqual({ type: 'set-goals', goals: { audience: 'general', formality: 'formal', domain: 'email', intent: 'inform' }, scope: 'host', host: 'mail.google.com' });
    expect(lastAction()).toEqual({ type: 'recheck', fieldId: 'f1' });
    expect(root.querySelector('[role=dialog]')).toBeNull();
    expect(root.querySelector('.jm-goals-summary')?.textContent).toBe('General · Formal · Email · Inform');
  });

  it('Escape closes the goals dialog and global scope omits the host', async () => {
    await mount();
    showField();
    click('[data-focus-key="goals"]');
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('[role=dialog]')).toBeNull();
    click('[data-focus-key="goals"]');
    click('[data-focus-key="goal:done"]');
    const msg = sentActions().find((m) => m.type === 'set-goals') as { scope: string; host?: string };
    expect(msg.scope).toBe('global');
    expect(msg.host).toBeUndefined();
  });

  it('category chips filter the list and send set-categories', async () => {
    await mount();
    showField();
    click('[data-focus-key="filter:clarity"]');
    expect(sentActions()).toContainEqual({ type: 'set-categories', categories: { correctness: true, clarity: false, engagement: true, delivery: true } });
    expect(root.querySelector('.jm-group-clarity')).toBeNull();
    expect(root.querySelector('[data-focus-key="filter:clarity"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector<HTMLButtonElement>('[data-group="style"] .jm-count-badge')?.textContent).toBe('1');
  });
});

describe('side panel: status line', () => {
  it('shows the pass name while checking', async () => {
    await mount();
    showField();
    port().emit({ type: 'check-progress', fieldId: 'f1', version: 3, pass: 'fast', stage: 'sent' });
    expect(root.querySelector('.jm-status')?.textContent).toContain('Checking with the fast pass…');
    port().emit({ type: 'check-progress', fieldId: 'f1', version: 3, pass: 'deep', stage: 'streaming' });
    expect(root.querySelector('.jm-status')?.textContent).toContain('Checking with the deep pass…');
    port().emit({ type: 'check-result', result: { fieldId: 'f1', version: 3, pass: 'deep', suggestions: [], fromCache: false, blocks: [] } });
    expect(root.querySelector('.jm-status')?.textContent).toContain('Looks good');
  });

  it('shows setup-type errors with an "Open settings" button and budget copy without model names', async () => {
    await mount();
    showField(field({ status: 'error', error: { code: 'no-api-key', message: 'No key', retryable: false } }));
    expect(root.querySelector('.jm-status.is-error')?.textContent).toContain('Add your Anthropic API key');
    click('[data-focus-key="status:settings"]');
    await flush();
    expect(mock.openOptionsPage.calls).toBe(1);
    port().emit({ type: 'field-state', state: field({ status: 'error', error: { code: 'budget', message: 'budget', retryable: false } }) });
    const budget = root.querySelector('.jm-status')!.textContent ?? '';
    expect(budget).toContain('Daily budget reached');
    expect(budget.toLowerCase()).not.toContain('haiku');
    expect(errorCopy({ code: 'consent-required', message: '', retryable: false }).settings).toBe(true);
    expect(errorCopy({ code: 'spend-cap', message: '', retryable: false }).message).toContain('spend cap');
    port().emit({ type: 'field-state', state: field({ status: 'error', error: { code: 'network', message: 'offline', retryable: true } }) });
    click('[data-focus-key="status:retry"]');
    expect(lastAction()).toEqual({ type: 'recheck', fieldId: 'f1' });
  });
});

describe('side panel: scratch document', () => {
  it('builds a valid CheckRequest with hashed blocks, dirty "all", deep pass and the scratch field kind', async () => {
    await mount();
    const area = root.querySelector<HTMLTextAreaElement>('.jm-scratch-input')!;
    area.value = 'Teh first line.\n\nSecond paragrph here.';
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="scratch:check"]');
    const msg = sentActions().find((m) => m.type === 'check') as Extract<PanelToWorker, { type: 'check' }>;
    const req: CheckRequest = msg.request;
    expect(req.fieldId).toBe(SCRATCH_FIELD_ID);
    expect(req.fieldKind).toBe('scratch');
    expect(req.pass).toBe('deep');
    expect(req.dirtyBlockHashes).toBe('all');
    expect(req.host).toBe('sidepanel');
    expect(req.context).toBe('doc');
    expect(req.protectedRanges).toEqual([]);
    expect(req.version).toBe(1);
    expect(req.blocks).toEqual(splitParagraphs(area.value));
    expect(req.blocks.map((b) => b.hash)).toEqual([hashText('Teh first line.'), hashText('Second paragrph here.')]);
    expect(req.blocks[1]?.start).toBe(17);
    expect(root.querySelector('.jm-status')?.textContent).toContain('Checking');
    expect(buildScratchRequest('', 2).blocks).toEqual([]);
  });

  it('renders scratch results and applies accepts locally, re-anchoring the remaining suggestions', async () => {
    await mount();
    const area = root.querySelector<HTMLTextAreaElement>('.jm-scratch-input')!;
    area.value = 'Teh cat sat on teh mat.';
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="scratch:check"]');
    const s1 = sugg({ id: 'x1', range: { start: 0, end: 3 }, highlight: { start: 0, end: 3 }, original: 'Teh', replacement: 'The' });
    const s2 = sugg({ id: 'x2', range: { start: 15, end: 18 }, highlight: { start: 15, end: 18 }, original: 'teh', replacement: 'the' });
    const overlapping = sugg({ id: 'x3', category: 'clarity', tier: 'B', range: { start: 0, end: 7 }, highlight: { start: 0, end: 7 }, original: 'Teh cat', replacement: 'The kitten' });
    const stale = sugg({ id: 'x4', range: { start: 4, end: 7 }, highlight: { start: 4, end: 7 }, original: 'dog', replacement: 'cat' });
    port().emit({ type: 'check-result', result: { fieldId: SCRATCH_FIELD_ID, version: 1, pass: 'deep', suggestions: [s1, s2, overlapping, stale], fromCache: false, blocks: [] } });
    expect(root.querySelectorAll('.jm-card').length).toBe(3);
    expect(root.querySelector('.jm-score-value')?.textContent).not.toBe('–');
    click('[data-focus-key="accept:x1"]');
    expect(area.value).toBe('The cat sat on teh mat.');
    expect(root.querySelector('.jm-card[data-suggestion-id="x3"]')).toBeNull();
    expect(app!.store.get().scratch.suggestions.map((s) => s.id)).toEqual(['x2']);
    expect(root.querySelectorAll('.jm-applied-item').length).toBe(1);
    expect(sentActions().some((m) => m.type === 'panel-action')).toBe(false);
    click('[data-focus-key="scratch:undo"]');
    expect(area.value).toBe('Teh cat sat on teh mat.');
    expect(app!.store.get().scratch.suggestions.length).toBe(3);
  });

  it('local accept-all applies the tier set right-to-left and shifts offsets; copy uses the clipboard', async () => {
    await mount();
    const area = root.querySelector<HTMLTextAreaElement>('.jm-scratch-input')!;
    area.value = 'aa bb cc dd';
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="scratch:check"]');
    const suggestions = [
      sugg({ id: 'r1', range: { start: 0, end: 2 }, highlight: { start: 0, end: 2 }, original: 'aa', replacement: 'alpha' }),
      sugg({ id: 'r2', range: { start: 6, end: 8 }, highlight: { start: 6, end: 8 }, original: 'cc', replacement: 'c' }),
      sugg({ id: 'r3', category: 'clarity', tier: 'B', range: { start: 9, end: 11 }, highlight: { start: 9, end: 11 }, original: 'dd', replacement: 'delta' }),
    ];
    port().emit({ type: 'check-result', result: { fieldId: SCRATCH_FIELD_ID, version: 1, pass: 'deep', suggestions, fromCache: false, blocks: [] } });
    click('[data-group="grammar"]');
    expect(area.value).toBe('alpha bb c dd');
    const remaining = app!.store.get().scratch.suggestions;
    expect(remaining.map((s) => s.id)).toEqual(['r3']);
    expect(remaining[0]?.range).toEqual({ start: 11, end: 13 });
    expect(area.value.slice(11, 13)).toBe('dd');
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const ok = await app!.actions.scratchCopy();
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('alpha bb c dd');
    expect(root.querySelector('.jm-toast')?.textContent).toContain('Copied');
    click('[data-focus-key="scratch:clear"]');
    expect(area.value).toBe('');
    expect(app!.store.get().scratch.suggestions).toEqual([]);
  });

  it('applyLocally picks the chosen alternative and drops suggestions whose text no longer matches', () => {
    const text = 'Teh cat.';
    const rewrite = sugg({ id: 'w', kind: 'rewrite', tier: 'C', range: { start: 0, end: 8 }, highlight: { start: 0, end: 8 }, original: 'Teh cat.', replacement: 'The cat.', alternatives: ['A cat.', 'Cat!'] });
    const result = applyLocally(text, [rewrite], ['w'], 2);
    expect(result.text).toBe('Cat!');
    expect(result.appliedIds).toEqual(['w']);
    const mismatch = sugg({ id: 'm', range: { start: 0, end: 3 }, highlight: { start: 0, end: 3 }, original: 'Xyz', replacement: 'The' });
    const skipped = applyLocally(text, [mismatch], ['m']);
    expect(skipped.appliedIds).toEqual([]);
    expect(skipped.skippedIds).toEqual(['m']);
    expect(skipped.text).toBe(text);
  });
});

describe('side panel: keyboard and resilience', () => {
  it('j/k move between cards, Enter accepts and Backspace dismisses the focused card', async () => {
    await mount();
    showField();
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(document.activeElement).toBe(card('sA'));
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(document.activeElement).toBe(card('sA2'));
    card('sA2').dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    expect(document.activeElement).toBe(card('sA'));
    card('sA').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(lastAction()).toMatchObject({ type: 'accept', suggestionId: 'sA' });
    card('sA').dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    expect(lastAction()).toMatchObject({ type: 'dismiss', suggestionId: 'sA' });
    // Typing in the scratch textarea never triggers shortcuts.
    const before = sentActions().length;
    const area = document.createElement('textarea');
    root.appendChild(area);
    area.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(sentActions().length).toBe(before);
  });

  it('every card and control is reachable by Tab (focusable) and groups collapse in memory', async () => {
    await mount();
    showField();
    expect(card('sA').getAttribute('tabindex')).toBe('0');
    expect(root.querySelectorAll('button:not([tabindex="-1"])').length).toBeGreaterThan(10);
    click('[data-focus-key="group:clarity"]');
    expect(root.querySelector('.jm-group-clarity .jm-cards')).toBeNull();
    expect(root.querySelector('[data-focus-key="group:clarity"]')?.getAttribute('aria-expanded')).toBe('false');
    port().emit({ type: 'field-state', state: richField() });
    expect(root.querySelector('.jm-group-clarity .jm-cards')).toBeNull();
    click('[data-focus-key="group:clarity"]');
    expect(root.querySelector('.jm-group-clarity .jm-cards')).not.toBeNull();
  });

  it('ignores garbage from the worker and renders a sane state when usage is unavailable', async () => {
    mock.respond = () => ({ ok: true, type: 'usage', usage: 'nope' });
    await mount();
    expect(root.querySelector('.jm-cost')?.textContent).toBe('Today: –');
    port().emit({ type: 'fields', fields: [{ nonsense: true }, null, richField()] });
    expect(root.querySelectorAll('.jm-card').length).toBe(6);
    port().emit({ type: 'field-state', state: 'garbage' });
    port().emit({ type: 'check-result', result: null });
    port().emit({ type: 'check-result', result: { fieldId: 'unknown', version: 1, pass: 'fast', suggestions: [], fromCache: false, blocks: [] } });
    port().emit(42);
    expect(root.querySelectorAll('.jm-card').length).toBe(6);
    mock.respond = () => Promise.reject(new Error('gone'));
    await app!.actions.refreshUsage();
    expect(root.querySelector('.jm-cost')?.textContent).toBe('Today: –');
  });

  it('shows a reconnecting badge and re-sends hello after the port drops', async () => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
    app = mountSidePanel(root, { usageRefreshMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const first = port();
    expect(root.querySelector('.jm-conn')).toBeNull();
    first.fireDisconnect();
    expect(root.querySelector('.jm-conn')?.textContent).toBe('Connecting…');
    await vi.advanceTimersByTimeAsync(600);
    expect(mock.ports.length).toBe(2);
    expect(port().sent[0]).toMatchObject({ type: 'hello', role: 'sidepanel', windowId: 11 });
    expect(root.querySelector('.jm-conn')).toBeNull();
  });
});


describe('adversarial', () => {
  it('scratch: a check-result with malformed suggestions keeps the valid ones and never wedges the spinner', async () => {
    await mount();
    const area = root.querySelector<HTMLTextAreaElement>('.jm-scratch-input')!;
    area.value = 'Teh cat sat.';
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="scratch:check"]');
    expect(app!.store.get().scratch.checking).toBe(true);
    const good = sugg({ id: 'ok1', range: { start: 0, end: 3 }, highlight: { start: 0, end: 3 }, original: 'Teh', replacement: 'The' });
    const noRange = { ...sugg({ id: 'bad1' }), range: undefined } as unknown as Suggestion;
    const badCategory = { ...sugg({ id: 'bad2', range: { start: 4, end: 7 }, original: 'cat' }), category: 'vibes' } as unknown as Suggestion;
    const negative = sugg({ id: 'bad3', range: { start: -1, end: 3 }, highlight: { start: -1, end: 3 }, original: 'Teh' });
    const unknownTier = { ...sugg({ id: 'tierX', range: { start: 4, end: 7 }, highlight: { start: 4, end: 7 }, original: 'cat', replacement: 'dog' }), tier: 'Z', alternatives: undefined, conflictsWith: undefined, explanation: undefined } as unknown as Suggestion;
    port().emit({ type: 'check-result', result: { fieldId: SCRATCH_FIELD_ID, version: 1, pass: 'deep', suggestions: [good, noRange, badCategory, negative, unknownTier, 'junk', null], fromCache: false, blocks: [] } });
    expect(app!.store.get().scratch.checking).toBe(false);
    const ids = Array.from(root.querySelectorAll<HTMLElement>('.jm-card')).map((c) => c.dataset.suggestionId).sort();
    expect(ids).toEqual(['ok1', 'tierX']);
    // Bulk accept goes by kind and category, not tier: a well-formed replacement with an unknown tier still applies.
    expect(root.querySelector<HTMLButtonElement>('[data-group="grammar"] .jm-count-badge')?.textContent).toBe('2');
    click('[data-group="all"]');
    expect(area.value).toBe('The dog sat.');
    expect(app!.store.get().scratch.suggestions).toEqual([]);
  });

  it('a field-state for an unknown field is shown, and one missing optional parts still renders', async () => {
    await mount();
    port().emit({ type: 'field-state', state: field({ fieldId: 'ghost', label: 'Ghost field', suggestions: [sugg({ id: 'g1' })] }) });
    expect(root.querySelector('.jm-field-label-text')?.textContent).toBe('Ghost field');
    expect(card('g1')).toBeTruthy();
    const bare = { fieldId: 'bare', status: 'suggestions', suggestions: [sugg({ id: 'b1' })], active: true, tone: { labels: [{ label: 'confident' }] } };
    port().emit({ type: 'field-state', state: bare });
    expect(root.querySelector('.jm-card[data-suggestion-id="b1"]')).not.toBeNull();
    expect(root.querySelector('.jm-group-applied')).toBeNull();
    expect(root.textContent).toContain('0 words');
    // Duplicate ids inside one `fields` message collapse to a single switcher entry.
    port().emit({ type: 'fields', fields: [field({ fieldId: 'dup' }), field({ fieldId: 'dup', active: false }), field({ fieldId: 'other', label: 'Other', active: false })] });
    const select = root.querySelector<HTMLSelectElement>('select[data-focus-key="field-switcher"]')!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['dup', 'other', SCRATCH_FIELD_ID]);
  });

  it('scratch: accepting one of two overlapping suggestions drops the other instead of shifting it onto the wrong text', () => {
    const text = 'Teh cat sat on the mat and the dog ran.';
    const fix = sugg({ id: 'fix', range: { start: 4, end: 7 }, highlight: { start: 4, end: 7 }, original: 'cat', replacement: 'kitten' });
    const before = sugg({ id: 'before', category: 'clarity', tier: 'B', range: { start: 0, end: 7 }, highlight: { start: 0, end: 7 }, original: 'Teh cat', replacement: 'The cat' });
    const after = sugg({ id: 'after', category: 'clarity', tier: 'B', range: { start: 4, end: 11 }, highlight: { start: 4, end: 11 }, original: 'cat sat', replacement: 'cat lay' });
    const containing = sugg({ id: 'contain', category: 'engagement', tier: 'B', range: { start: 0, end: 15 }, highlight: { start: 0, end: 15 }, original: 'Teh cat sat on ', replacement: 'The cat sat on ' });
    const touching = sugg({ id: 'touch', range: { start: 7, end: 11 }, highlight: { start: 7, end: 11 }, original: ' sat', replacement: ' sits' });
    const far = sugg({ id: 'far', range: { start: 31, end: 34 }, highlight: { start: 31, end: 34 }, original: 'dog', replacement: 'hound' });
    const result = applyLocally(text, [fix, before, after, containing, touching, far], ['fix']);
    expect(result.text).toBe('Teh kitten sat on the mat and the dog ran.');
    expect(result.appliedIds).toEqual(['fix']);
    const ids = result.suggestions.map((s) => s.id);
    expect(ids).toEqual(['touch', 'far']);
    for (const s of result.suggestions) expect(result.text.slice(s.range.start, s.range.end)).toBe(s.original);
    expect(result.suggestions.find((s) => s.id === 'far')?.range).toEqual({ start: 34, end: 37 });
    expect(result.suggestions.find((s) => s.id === 'touch')?.range).toEqual({ start: 10, end: 14 });
    // Accepting both overlapping ones at once: the first by start wins, the other is reported skipped and removed.
    const both = applyLocally(text, [fix, after], ['fix', 'after']);
    expect(both.appliedIds).toEqual(['fix']);
    expect(both.skippedIds).toEqual(['after']);
    expect(both.suggestions).toEqual([]);
  });

  it('scratch: accepting a deletion shifts later suggestions left and lists it as a removal', async () => {
    await mount();
    const area = root.querySelector<HTMLTextAreaElement>('.jm-scratch-input')!;
    area.value = 'The the cat sat on teh mat.';
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="scratch:check"]');
    const del = sugg({ id: 'del', kind: 'delete', rule: 'repeated_word', range: { start: 4, end: 8 }, highlight: { start: 0, end: 7 }, original: 'the ', replacement: '', title: 'Remove the repeated word' });
    const later = sugg({ id: 'later', range: { start: 19, end: 22 }, highlight: { start: 19, end: 22 }, original: 'teh', replacement: 'the' });
    port().emit({ type: 'check-result', result: { fieldId: SCRATCH_FIELD_ID, version: 1, pass: 'deep', suggestions: [del, later], fromCache: false, blocks: [] } });
    expect(card('del').querySelector('.jm-remove')?.textContent).toBe('Remove');
    click('[data-focus-key="accept:del"]');
    expect(area.value).toBe('The cat sat on teh mat.');
    const remaining = app!.store.get().scratch.suggestions;
    expect(remaining.map((s) => s.id)).toEqual(['later']);
    expect(remaining[0]?.range).toEqual({ start: 15, end: 18 });
    expect(remaining[0]?.highlight).toEqual({ start: 15, end: 18 });
    expect(area.value.slice(15, 18)).toBe('teh');
    const applied = root.querySelector('.jm-applied-item')!;
    expect(applied.textContent).toContain('Remove the repeated word');
    expect(applied.querySelector('.jm-replacement-text')?.textContent).toBe('∅');
  });

  it('scratch: accepting an insertion keeps a suggestion that starts exactly at the insertion point anchored to its word', () => {
    const text = 'Helloworld is grate.';
    const insert = sugg({ id: 'ins', kind: 'insert', rule: 'spacing', range: { start: 5, end: 5 }, highlight: { start: 0, end: 10 }, original: '', replacement: ' ', title: 'Add a space' });
    const atPoint = sugg({ id: 'at', range: { start: 5, end: 10 }, highlight: { start: 5, end: 10 }, original: 'world', replacement: 'World' });
    const after = sugg({ id: 'after', range: { start: 14, end: 19 }, highlight: { start: 14, end: 19 }, original: 'grate', replacement: 'great' });
    const result = applyLocally(text, [insert, atPoint, after], ['ins']);
    expect(result.text).toBe('Hello world is grate.');
    expect(result.appliedIds).toEqual(['ins']);
    const ids = result.suggestions.map((s) => s.id);
    expect(ids).toEqual(['at', 'after']);
    for (const s of result.suggestions) {
      expect(result.text.slice(s.range.start, s.range.end)).toBe(s.original);
      expect(result.text.slice(s.highlight.start, s.highlight.end)).toBe(s.original);
    }
    expect(result.suggestions.find((s) => s.id === 'at')?.range).toEqual({ start: 6, end: 11 });
    expect(result.suggestions.find((s) => s.id === 'after')?.range).toEqual({ start: 15, end: 20 });
    // The insertion's own applied item renders its highlight-less range legibly.
    expect(result.applied[0]).toMatchObject({ id: 'ins', original: '', replacement: ' ' });
    // An insertion inside a replaced span is dropped; one at its very start survives in front of the replacement.
    const repl = sugg({ id: 'repl', range: { start: 14, end: 19 }, highlight: { start: 14, end: 19 }, original: 'grate', replacement: 'great' });
    const inside = sugg({ id: 'inside', kind: 'insert', range: { start: 16, end: 16 }, highlight: { start: 14, end: 19 }, original: '', replacement: '-' });
    const atStart = sugg({ id: 'atStart', kind: 'insert', range: { start: 14, end: 14 }, highlight: { start: 11, end: 14 }, original: '', replacement: 'so ' });
    const r2 = applyLocally(text, [repl, inside, atStart], ['repl']);
    expect(r2.suggestions.map((s) => s.id)).toEqual(['atStart']);
    expect(r2.suggestions[0]?.range).toEqual({ start: 14, end: 14 });
  });

  it('accept-all with a suggestionIds subset applies only that subset (never tier C) and forwards it verbatim for fields', async () => {
    await mount();
    const area = root.querySelector<HTMLTextAreaElement>('.jm-scratch-input')!;
    area.value = 'aa bb cc dd';
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="scratch:check"]');
    const suggestions = [
      sugg({ id: 'a1', range: { start: 0, end: 2 }, highlight: { start: 0, end: 2 }, original: 'aa', replacement: 'A' }),
      sugg({ id: 'a2', range: { start: 3, end: 5 }, highlight: { start: 3, end: 5 }, original: 'bb', replacement: 'B' }),
      sugg({ id: 'b1', category: 'clarity', tier: 'B', range: { start: 6, end: 8 }, highlight: { start: 6, end: 8 }, original: 'cc', replacement: 'C' }),
      sugg({ id: 'c1', category: 'delivery', tier: 'C', kind: 'rewrite', range: { start: 9, end: 11 }, highlight: { start: 9, end: 11 }, original: 'dd', replacement: 'D' }),
    ];
    port().emit({ type: 'check-result', result: { fieldId: SCRATCH_FIELD_ID, version: 1, pass: 'deep', suggestions, fromCache: false, blocks: [] } });
    app!.actions.acceptAll('all', ['a2', 'c1', 'nope']);
    expect(area.value).toBe('aa B cc dd');
    expect(app!.store.get().scratch.suggestions.map((s) => s.id).sort()).toEqual(['a1', 'b1', 'c1']);
    app!.actions.acceptAll('grammar', []);
    expect(area.value).toBe('aa B cc dd');
    expect(root.querySelector('.jm-toast')?.textContent).toBe('Nothing to apply');
    // Field mode: the subset travels inside AcceptAllScope untouched.
    showField();
    app!.actions.acceptAll('style', ['sB']);
    expect(lastAction()).toEqual({ type: 'accept-all', fieldId: 'f1', scope: { group: 'style', suggestionIds: ['sB'] } });
  });

  it('counts above 99 render as "99+" with the exact number in the title', async () => {
    await mount();
    const many = Array.from({ length: 150 }, (_, i) => sugg({ id: `n${i}`, range: { start: i, end: i + 1 }, highlight: { start: i, end: i + 1 }, original: 'x', replacement: 'y' }));
    showField(field({ suggestions: many, textPreview: 'x'.repeat(150), wordCount: 150 }));
    const badge = root.querySelector<HTMLElement>('[data-group="grammar"] .jm-count-badge')!;
    expect(badge.textContent).toBe('99+');
    expect(badge.title).toBe('150');
    expect(root.querySelector<HTMLElement>('[data-focus-key="filter:correctness"] .jm-filter-count')?.textContent).toBe('99+');
    expect(root.querySelector<HTMLElement>('.jm-group-correctness .jm-group-count')?.textContent).toBe('99+');
    expect(root.querySelector('.jm-group-correctness .jm-group-count')?.getAttribute('title')).toBe('150');
    expect(root.querySelector('.jm-status')?.textContent).toContain('150 suggestions');
    expect(root.querySelectorAll('.jm-card').length).toBe(150);
    port().emit({ type: 'field-state', state: field({ suggestions: many.slice(0, 99) }) });
    expect(root.querySelector<HTMLElement>('[data-group="grammar"] .jm-count-badge')?.textContent).toBe('99');
  });

  it('a very long explanation is clamped behind "Learn more", and a huge title or replacement never breaks the card', async () => {
    await mount();
    const long = 'Because '.repeat(400).trim();
    const s = sugg({ id: 'long', explanation: long, title: 'T'.repeat(3000), replacement: 'r'.repeat(5000) });
    showField(field({ suggestions: [s] }));
    const p = card('long').querySelector<HTMLElement>('.jm-card-explanation')!;
    expect(p.textContent!.length).toBeLessThan(160 + 'Learn more'.length);
    expect(p.textContent!.endsWith('Learn more')).toBe(true);
    expect(p.textContent).toContain('…');
    p.querySelector('button')!.click();
    const expanded = card('long').querySelector<HTMLElement>('.jm-card-explanation')!;
    expect(expanded.textContent).toContain(long);
    expect(expanded.textContent!.endsWith('Less')).toBe(true);
    expect(card('long').querySelector('.jm-replacement')?.textContent?.length).toBe(5000);
    const exact = sugg({ id: 'exact', explanation: 'e'.repeat(140) });
    port().emit({ type: 'field-state', state: field({ suggestions: [exact] }) });
    expect(card('exact').querySelector('.jm-card-explanation button')).toBeNull();
  });

  it('a port disconnect in the middle of a render keeps the fields, ignores the dead port and resumes after reconnect in order', async () => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
    app = mountSidePanel(root, { usageRefreshMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const first = port();
    first.emit({ type: 'fields', fields: [richField()] });
    expect(root.querySelectorAll('.jm-card').length).toBe(6);
    // Drop the port from inside a store notification (i.e. while the panel is re-rendering).
    let fired = false;
    const off = app.store.subscribe(() => {
      if (!fired) {
        fired = true;
        first.fireDisconnect();
      }
    });
    app.actions.toggleGroup('delivery');
    off();
    expect(fired).toBe(true);
    expect(root.querySelector('.jm-conn')?.textContent).toBe('Connecting…');
    expect(root.querySelectorAll('.jm-card').length).toBe(5);
    expect(root.querySelector('.jm-group-delivery .jm-cards')).toBeNull();
    // Messages from the dead port must not touch state.
    first.emit({ type: 'fields', fields: [] });
    expect(root.querySelectorAll('.jm-card').length).toBe(5);
    // Actions while disconnected are queued and flushed after hello.
    app.actions.toggleCategory('clarity');
    expect(mock.ports.length).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    expect(mock.ports.length).toBe(2);
    const second = port();
    expect(second.sent[0]).toMatchObject({ type: 'hello', role: 'sidepanel' });
    expect(second.sent[1]).toMatchObject({ type: 'set-categories', categories: { clarity: false } });
    expect(root.querySelector('.jm-conn')).toBeNull();
    second.emit({ type: 'fields', fields: [field({ suggestions: [sugg({ id: 'fresh' })] })] });
    expect(root.querySelectorAll('.jm-card').length).toBe(1);
    expect(card('fresh')).toBeTruthy();
  });

  it('Enter on a focused card accepts exactly once: key repeat and a second press before the worker answers are ignored', async () => {
    await mount();
    showField();
    // Focusing a card re-renders the panel (focus state), so always re-query the live card before dispatching.
    card('sA').focus();
    expect(document.activeElement).toBe(card('sA'));
    card('sA').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const accepts = (): number => sentActions().filter((m) => m.type === 'panel-action' && (m as { action: { type: string } }).action.type === 'accept').length;
    expect(accepts()).toBe(1);
    card('sA').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }));
    expect(accepts()).toBe(1);
    card('sA').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(accepts()).toBe(1);
    // Mouse on the Accept button of the same (still pending) card is also a duplicate.
    click('[data-focus-key="accept:sA"]');
    expect(accepts()).toBe(1);
    // Other cards are unaffected.
    click('[data-focus-key="accept:sA2"]');
    expect(accepts()).toBe(2);
    // The worker's answer clears the pending state, after which the card can be accepted again.
    port().emit({ type: 'field-state', state: richField() });
    card('sA').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(accepts()).toBe(3);
    // Enter inside a button within the card is left to the button (no double accept from the card handler).
    const btn = card('sB').querySelector<HTMLElement>('[data-focus-key="dismiss:sB"]')!;
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(accepts()).toBe(3);
  });

  it('the worker answering { ok:false } for usage and sending a garbage goals config still yields complete goals', async () => {
    mock.respond = () => ({ ok: false, error: { code: 'storage', message: 'nope' } });
    await mount();
    expect(root.querySelector('.jm-cost')?.textContent).toBe('Today: –');
    expect(root.querySelector('.jm-toast')).toBeNull();
    port().emit({ type: 'config', config: { goals: { formality: 'formal', bogus: 1 }, categories: { clarity: false }, host: 'x.example' }, settings: { apiKey: 'sk-ant-leak', hasApiKey: true }, sync: 'weird' });
    showField();
    expect(root.querySelector('.jm-goals-summary')?.textContent).toBe('General · Formal · General · Inform');
    expect(root.textContent).not.toContain('sk-ant-leak');
    expect(app!.store.get().settings).not.toHaveProperty('apiKey');
    expect(app!.store.get().sync).toBeNull();
    click('[data-focus-key="goals"]');
    click('[data-focus-key="goal:done"]', root.querySelector('[role=dialog]')!);
    const msg = sentActions().find((m) => m.type === 'set-goals') as Extract<PanelToWorker, { type: 'set-goals' }>;
    expect(msg.goals).toEqual({ audience: 'general', formality: 'formal', domain: 'general', intent: 'inform' });
  });

  it('a scratch check that never gets an answer times out into a retryable error instead of spinning forever', async () => {
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.appendChild(root);
    app = mountSidePanel(root, { usageRefreshMs: 0, scratchTimeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(10);
    const area = root.querySelector<HTMLTextAreaElement>('.jm-scratch-input')!;
    area.value = 'Teh cat.';
    area.dispatchEvent(new Event('input'));
    click('[data-focus-key="scratch:check"]');
    expect(root.querySelector<HTMLButtonElement>('[data-focus-key="scratch:check"]')?.disabled).toBe(true);
    // Progress from the worker keeps the request alive.
    await vi.advanceTimersByTimeAsync(4000);
    port().emit({ type: 'check-progress', fieldId: SCRATCH_FIELD_ID, version: 1, pass: 'deep', stage: 'streaming' });
    await vi.advanceTimersByTimeAsync(4000);
    expect(app.store.get().scratch.checking).toBe(true);
    await vi.advanceTimersByTimeAsync(1100);
    expect(app.store.get().scratch.checking).toBe(false);
    expect(root.querySelector('.jm-status.is-error')?.textContent).toContain("didn't finish");
    expect(root.querySelector<HTMLButtonElement>('[data-focus-key="scratch:check"]')?.disabled).toBe(false);
    click('[data-focus-key="status:retry"]');
    const checks = sentActions().filter((m) => m.type === 'check') as Extract<PanelToWorker, { type: 'check' }>[];
    expect(checks.length).toBe(2);
    expect(checks[1]?.request.version).toBe(2);
    // A late answer for the timed-out version is ignored; the current one lands.
    port().emit({ type: 'check-result', result: { fieldId: SCRATCH_FIELD_ID, version: 1, pass: 'deep', suggestions: [sugg({ id: 'late', original: 'Teh', range: { start: 0, end: 3 } })], fromCache: false, blocks: [] } });
    expect(app.store.get().scratch.checking).toBe(true);
    port().emit({ type: 'check-result', result: { fieldId: SCRATCH_FIELD_ID, version: 2, pass: 'deep', suggestions: [], fromCache: false, blocks: [] } });
    expect(app.store.get().scratch.checking).toBe(false);
    expect(root.querySelector('.jm-status')?.textContent).toContain('Looks good');
  });
});

// Type-level sanity: the category union used by the fixtures matches the contract.
const _cat: SuggestionCategory = 'correctness';
void _cat;
