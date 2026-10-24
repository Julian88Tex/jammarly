/**
 * Side panel rendering: pure functions from PanelState to DOM. The whole panel is rebuilt on every state change
 * except the scratch textarea and the toast host, which persist across renders.
 */
import type { ApplyTransaction, CheckError, DismissReason, FieldState, Suggestion, ToneAnalysis, WritingGoals } from '@jammarly/shared/types';
import { CATEGORIES, TONE_EMOJI, TONE_EMOJI_FALLBACK } from '@jammarly/shared/types';
import { fragment, h, replaceChildren, type Child } from '../common/dom';
import { formatReadingTime, formatUsdPrecise, plural, truncate, visibleText } from '../common/format';
import { formatBadge, normalizeGoals } from '../common/guards';
import { brandMark, icon, scoreRing } from '../common/icons';
import { CATEGORY_LABELS } from '../common/theme';
import { button, categoryDot, chip, emptyState, inlineConfirm, segmented, select, switchControl, type ToastHandle } from '../common/ui';
import type { PanelActions } from './app';
import {
  PREVIEW_ROWS,
  SCRATCH_FIELD_ID,
  TONE_MIN_CHARS,
  countByCategory,
  currentField,
  groupByCategory,
  isScratchView,
  isSpellingRule,
  orderedFields,
  progressCopy,
  showTone,
  tierCounts,
  tierSet,
  visibleSuggestions,
  type AcceptAllGroup,
  type AppliedItem,
  type PanelState,
  type TierCounts,
} from './state';

export interface PanelView {
  scratchTextarea: HTMLTextAreaElement | null;
  toast: ToastHandle;
}

const GROUP_LABEL: Record<AcceptAllGroup, string> = { grammar: 'Accept all grammar', style: 'Accept all style', all: 'Accept everything' };

const DISMISS_REASONS: { reason: DismissReason; label: string }[] = [
  { reason: 'not_error', label: 'Not an error' },
  { reason: 'meant_this', label: 'I meant this' },
  { reason: 'not_here', label: 'Not here' },
  { reason: 'never', label: 'Never show this' },
];

const AUDIENCES: { value: WritingGoals['audience']; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'knowledgeable', label: 'Knowledgeable' },
  { value: 'expert', label: 'Expert' },
];
const FORMALITIES: { value: WritingGoals['formality']; label: string }[] = [
  { value: 'informal', label: 'Informal' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'formal', label: 'Formal' },
];
const DOMAINS: { value: WritingGoals['domain']; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'academic', label: 'Academic' },
  { value: 'business', label: 'Business' },
  { value: 'email', label: 'Email' },
  { value: 'casual', label: 'Casual' },
  { value: 'creative', label: 'Creative' },
  { value: 'technical', label: 'Technical' },
];
const INTENTS: { value: WritingGoals['intent']; label: string }[] = [
  { value: 'inform', label: 'Inform' },
  { value: 'describe', label: 'Describe' },
  { value: 'convince', label: 'Convince' },
  { value: 'tell_a_story', label: 'Tell a story' },
];

function labelOf<T extends string>(options: { value: T; label: string }[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export function renderPanel(root: HTMLElement, state: PanelState, actions: PanelActions, view: PanelView): void {
  root.classList.add('jm-panel');
  const scratch = isScratchView(state);
  const field = scratch ? null : currentField(state);
  const children: Child[] = [renderHeader(state, actions)];

  if (field) {
    const suggestions = visibleSuggestions(field.suggestions, state.categories);
    children.push(
      renderSummary(field.score?.overall ?? null, field.wordCount, field.score?.readingTimeSeconds ?? null, showTone(field) ? field.tone ?? null : null),
      renderGoalsRow(state, actions, field.host),
      renderFilterChips(state, actions, field.suggestions),
      renderAcceptAllBar(state, actions, suggestions),
      renderStatus(state, actions, field),
      renderApplied(state, actions, transactionsToItems(field.transactions), field.transactions[0]),
      renderGroups(state, actions, suggestions),
    );
  } else {
    children.push(renderScratch(state, actions, view));
  }
  children.push(renderFooter(state, actions));
  if (state.ui.dialog) children.push(renderGoalsDialog(state, actions, field?.host ?? state.config?.host ?? null));
  children.push(view.toast.element);
  replaceChildren(root, ...children);
}

// ---------------------------------------------------------------------------
// Header, summary, goals, filters
// ---------------------------------------------------------------------------

function renderHeader(state: PanelState, actions: PanelActions): HTMLElement {
  const fields = orderedFields(state);
  const current = isScratchView(state) ? null : currentField(state);
  let switcher: HTMLElement;
  if (fields.length === 0) {
    switcher = h('div', { class: 'jm-field-switcher jm-field-none' }, h('span', { class: 'jm-field-label-text' }, 'No field focused'));
  } else if (fields.length === 1 && current) {
    switcher = h(
      'div',
      { class: 'jm-field-switcher jm-field-single' },
      h('div', { class: 'jm-field-single-text' }, h('span', { class: 'jm-field-label-text' }, current.label || 'Text field'), h('span', { class: 'jm-field-host' }, current.host)),
      button({ kind: 'ghost', size: 'sm', label: 'Check text', onClick: () => actions.selectField(SCRATCH_FIELD_ID), focusKey: 'field-switcher', title: 'Paste text to check it here' }),
    );
  } else {
    const options = [...fields.map((f) => ({ value: f.fieldId, label: `${f.label || 'Text field'} · ${f.host}` })), { value: SCRATCH_FIELD_ID, label: 'Check text' }];
    switcher = h(
      'div',
      { class: 'jm-field-switcher' },
      select({
        options,
        value: current ? current.fieldId : SCRATCH_FIELD_ID,
        ariaLabel: 'Field to review',
        focusKey: 'field-switcher',
        onChange: (value) => actions.selectField(value),
      }),
    );
  }
  const status = state.portStatus;
  return h(
    'header',
    { class: 'jm-header' },
    h('div', { class: 'jm-brand' }, brandMark(20), h('span', { class: 'jm-brand-name' }, 'Jammarly'), status !== 'open' ? h('span', { class: 'jm-conn', title: 'Reconnecting to the extension' }, status === 'closed' ? 'Disconnected' : 'Connecting…') : null),
    switcher,
    button({ kind: 'ghost', icon: 'settings', label: 'Settings', iconOnly: true, onClick: () => actions.openSettings(), focusKey: 'settings' }),
  );
}

function renderSummary(score: number | null, wordCount: number, readingSeconds: number | null, tone: ToneAnalysis | null): HTMLElement {
  const stats = h('div', { class: 'jm-stats' }, h('span', { class: 'jm-stat' }, plural(wordCount, 'word')), readingSeconds !== null ? h('span', { class: 'jm-stat' }, formatReadingTime(readingSeconds)) : null);
  const row = h('section', { class: 'jm-summary', 'aria-label': 'Score and tone' }, scoreRing(score), h('div', { class: 'jm-summary-text' }, h('div', { class: 'jm-summary-title' }, score === null ? 'No score yet' : score >= 90 ? 'Great' : score >= 70 ? 'Good' : 'Needs work'), stats));
  if (tone && tone.labels.length > 0) {
    const primary = tone.labels[0];
    if (primary) {
      row.appendChild(
        h(
          'div',
          { class: 'jm-tone', title: tone.summary || undefined, role: 'img', 'aria-label': `Tone: ${tone.labels.map((l) => l.label).join(', ')}` },
          h('span', { class: 'jm-tone-emoji', 'aria-hidden': 'true' }, TONE_EMOJI[primary.label] ?? TONE_EMOJI_FALLBACK),
          h('span', { class: 'jm-tone-label' }, capitalize(primary.label)),
          tone.labels.length > 1 ? h('span', { class: 'jm-tone-more' }, `+${tone.labels.length - 1}`) : null,
        ),
      );
    }
  }
  return row;
}

function renderGoalsRow(state: PanelState, actions: PanelActions, host: string | null): HTMLElement {
  const goals = normalizeGoals(state.config?.goals);
  const summary = [labelOf(AUDIENCES, goals.audience), labelOf(FORMALITIES, goals.formality), labelOf(DOMAINS, goals.domain), labelOf(INTENTS, goals.intent)].join(' · ');
  return h(
    'button',
    { type: 'button', class: 'jm-goals-row', onclick: () => actions.openGoals(), 'aria-haspopup': 'dialog', title: host ? `Goals for ${host}` : 'Goals', dataset: { focusKey: 'goals' } },
    icon('target'),
    h('span', { class: 'jm-goals-label' }, 'Goals'),
    h('span', { class: 'jm-goals-summary' }, summary),
    icon('chevron-right'),
  );
}

function renderFilterChips(state: PanelState, actions: PanelActions, all: readonly Suggestion[]): HTMLElement {
  const counts = countByCategory(all);
  return h(
    'div',
    { class: 'jm-filters', role: 'group', 'aria-label': 'Filter by category' },
    CATEGORIES.map((category) => {
      const on = state.categories[category] !== false;
      return h(
        'button',
        {
          type: 'button',
          class: ['jm-filter-chip', on ? 'is-on' : 'is-off'],
          'aria-pressed': String(on),
          onclick: () => actions.toggleCategory(category),
          dataset: { category, focusKey: `filter:${category}` },
        },
        categoryDot(category),
        h('span', null, CATEGORY_LABELS[category]),
        h('span', { class: 'jm-filter-count', title: counts[category] > 99 ? String(counts[category]) : undefined }, formatBadge(counts[category])),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Accept all
// ---------------------------------------------------------------------------

function renderAcceptAllBar(state: PanelState, actions: PanelActions, suggestions: readonly Suggestion[]): HTMLElement {
  const counts = tierCounts(suggestions);
  const preview = state.ui.preview;
  const bar = h('section', { class: 'jm-accept-all', 'aria-label': 'Accept all' });
  bar.addEventListener('mouseleave', () => actions.previewLeave());
  bar.addEventListener('focusout', (ev) => {
    const next = (ev as FocusEvent).relatedTarget;
    if (!(next instanceof Node) || !bar.contains(next)) actions.previewLeave();
  });
  const buttons = h('div', { class: 'jm-accept-buttons' });
  for (const group of ['grammar', 'style', 'all'] as const) {
    buttons.appendChild(renderAcceptButton(group, counts, actions, preview?.group === group));
  }
  bar.appendChild(buttons);
  if (counts.rewrites > 0) {
    bar.appendChild(h('div', { class: 'jm-accept-note', id: 'jm-accept-note' }, `${plural(counts.rewrites, 'rewrite')} need${counts.rewrites === 1 ? 's' : ''} your choice`));
  }
  if (preview) bar.appendChild(renderPreview(actions, suggestions, preview.group, preview.choose, preview.selected));
  return bar;
}

function renderAcceptButton(group: AcceptAllGroup, counts: TierCounts, actions: PanelActions, open: boolean): HTMLElement {
  const count = counts[group];
  const label = GROUP_LABEL[group];
  const wrap = h('div', { class: ['jm-accept-group', open ? 'is-open' : null] });
  const main = h(
    'button',
    {
      type: 'button',
      class: ['jm-btn', group === 'all' ? 'jm-btn-primary' : 'jm-btn-secondary', 'jm-accept-btn'],
      disabled: count === 0,
      'aria-describedby': [open ? 'jm-preview' : null, group === 'all' && counts.rewrites > 0 ? 'jm-accept-note' : null].filter(Boolean).join(' ') || undefined,
      dataset: { group, focusKey: `accept-all:${group}` },
      onclick: () => actions.acceptAll(group),
      onmouseenter: () => count > 0 && actions.previewEnter(group),
      onfocus: () => count > 0 && actions.previewEnter(group),
    },
    h('span', { class: 'jm-btn-label' }, label),
    h('span', { class: 'jm-count-badge', title: count > 99 ? String(count) : undefined }, formatBadge(count)),
  );
  const toggle = h(
    'button',
    {
      type: 'button',
      class: ['jm-btn', 'jm-btn-ghost', 'jm-btn-sm', 'jm-accept-more'],
      'aria-label': `Preview ${label.toLowerCase()}`,
      'aria-expanded': String(open),
      disabled: count === 0,
      onclick: () => actions.previewPin(group),
    },
    icon('chevron-down'),
  );
  wrap.append(main, toggle);
  return wrap;
}

function renderPreview(actions: PanelActions, suggestions: readonly Suggestion[], group: AcceptAllGroup, choose: boolean, selected: readonly string[]): HTMLElement {
  const set = tierSet(suggestions, group);
  const pop = h('div', { class: ['jm-preview', choose ? 'is-choose' : null], id: 'jm-preview', role: choose ? 'group' : 'tooltip', 'aria-label': `${GROUP_LABEL[group]} preview` });
  pop.addEventListener('mouseenter', () => actions.previewEnter(group));
  if (set.length === 0) {
    pop.appendChild(h('p', { class: 'jm-preview-empty' }, 'Nothing to apply in this group.'));
    return pop;
  }
  const head = h('div', { class: 'jm-preview-head' }, h('span', { class: 'jm-preview-title' }, choose ? `Choose what to apply (${selected.length}/${set.length})` : `${GROUP_LABEL[group]} will apply ${plural(set.length, 'change')}`));
  if (choose) {
    const allOn = selected.length === set.length;
    head.appendChild(button({ kind: 'link', size: 'sm', label: allOn ? 'Clear all' : 'Select all', onClick: () => actions.previewSelectAll(!allOn) }));
  }
  pop.appendChild(head);
  const rows = choose ? set : set.slice(0, PREVIEW_ROWS);
  const list = h('ul', { class: 'jm-preview-list' });
  for (const s of rows) {
    const row = h('li', { class: 'jm-preview-row' });
    if (choose) {
      const id = `prev-${s.id}`;
      const box = h('input', { type: 'checkbox', id, checked: selected.includes(s.id), onchange: () => actions.previewToggle(s.id), dataset: { suggestionId: s.id, focusKey: `preview:${s.id}` } });
      row.append(box, h('label', { for: id, class: 'jm-preview-change' }, categoryDot(s.category, CATEGORY_LABELS[s.category]), diffInline(s)));
    } else {
      row.append(categoryDot(s.category, CATEGORY_LABELS[s.category]), diffInline(s));
    }
    list.appendChild(row);
  }
  pop.appendChild(list);
  if (!choose && set.length > PREVIEW_ROWS) pop.appendChild(h('div', { class: 'jm-preview-more' }, `+${set.length - PREVIEW_ROWS} more`));
  const foot = h('div', { class: 'jm-preview-foot' });
  if (choose) {
    foot.append(
      button({ kind: 'primary', size: 'sm', label: `Accept selected (${selected.length})`, disabled: selected.length === 0, onClick: () => actions.acceptAll(group, [...selected]), focusKey: 'preview:accept' }),
      button({ kind: 'ghost', size: 'sm', label: 'Cancel', onClick: () => actions.closePreview() }),
    );
  } else {
    foot.append(button({ kind: 'link', size: 'sm', label: 'Choose…', onClick: () => actions.previewChoose(group), focusKey: 'preview:choose' }));
  }
  pop.appendChild(foot);
  return pop;
}

function diffInline(s: Suggestion): HTMLElement {
  const el = h('span', { class: 'jm-diff-inline' });
  if (s.kind === 'flag') {
    el.appendChild(h('span', { class: 'jm-flagged' }, truncate(s.original, 60)));
    return el;
  }
  el.append(h('s', { class: 'jm-original' }, visibleText(truncate(s.original, 60))), h('span', { class: 'jm-arrow', 'aria-hidden': 'true' }, '→'), h('span', { class: 'jm-replacement-text' }, s.kind === 'delete' ? 'Remove' : visibleText(truncate(s.replacement, 60))));
  return el;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function renderStatus(state: PanelState, actions: PanelActions, field: FieldState): HTMLElement {
  const progress = state.progress[field.fieldId];
  const line = h('div', { class: 'jm-status', role: 'status', 'aria-live': 'polite' });
  if (progress || field.status === 'checking') {
    line.append(icon('spinner', { class: 'jm-spin' }), h('span', null, progress ? progressCopy(progress) : 'Checking…'));
    return line;
  }
  if (field.error || field.status === 'error') {
    line.classList.add('is-error');
    return renderError(line, actions, field.error ?? { code: 'unknown', message: 'Something went wrong.', retryable: true });
  }
  switch (field.status) {
    case 'setup':
      line.append(icon('alert'), h('span', null, 'Finish setting up Jammarly to start checking.'), button({ kind: 'link', size: 'sm', label: 'Open settings', onClick: () => actions.openSettings() }));
      break;
    case 'clean':
      line.classList.add('is-clean');
      line.append(icon('check'), h('span', null, 'Looks good'));
      break;
    case 'suggestions': {
      const n = visibleSuggestions(field.suggestions, state.categories).length;
      line.append(h('span', null, n === 0 ? 'All suggestions are filtered out' : plural(n, 'suggestion')));
      break;
    }
    case 'off':
      line.append(icon('power'), h('span', null, `Jammarly is off on ${field.host}`));
      break;
    case 'unsupported':
      line.append(icon('info'), h('span', null, "This field isn't supported yet."));
      break;
    case 'idle':
    default:
      line.append(h('span', null, field.wordCount === 0 ? 'Start typing to get suggestions.' : 'Waiting for a pause in typing…'));
  }
  return line;
}

export function errorCopy(error: CheckError): { message: string; settings: boolean } {
  switch (error.code) {
    case 'no-api-key':
      return { message: 'Add your Anthropic API key to start checking.', settings: true };
    case 'consent-required':
      return { message: 'Finish the first-run setup before text can be checked.', settings: true };
    case 'auth':
      return { message: 'Your API key was rejected. Check it in Settings.', settings: true };
    case 'budget':
      return { message: 'Daily budget reached. Only the fast pass runs until midnight; raise the budget in Settings.', settings: true };
    case 'spend-cap':
      return { message: 'Your Anthropic spend cap was reached. Raise it in the Anthropic console; checks resume afterwards.', settings: false };
    case 'rate-limit':
      return { message: `Rate limited. Retrying${error.retryAfterMs ? ` in ${Math.ceil(error.retryAfterMs / 1000)} s` : ' shortly'}.`, settings: false };
    case 'network':
      return { message: "Can't reach Anthropic. Check your connection.", settings: false };
    case 'disabled':
      return { message: 'Jammarly is turned off.', settings: true };
    case 'truncated':
      return { message: "Couldn't check one paragraph; it was too long.", settings: false };
    default:
      return { message: error.message || 'Something went wrong.', settings: false };
  }
}

function renderError(line: HTMLElement, actions: PanelActions, error: CheckError): HTMLElement {
  const copy = errorCopy(error);
  line.append(icon('alert'), h('span', { class: 'jm-status-text' }, copy.message));
  if (copy.settings) line.appendChild(button({ kind: 'link', size: 'sm', label: 'Open settings', onClick: () => actions.openSettings(), focusKey: 'status:settings' }));
  if (error.retryable) line.appendChild(button({ kind: 'link', size: 'sm', label: 'Retry', onClick: () => actions.recheck(), focusKey: 'status:retry' }));
  return line;
}

// ---------------------------------------------------------------------------
// Recently applied
// ---------------------------------------------------------------------------

function transactionsToItems(transactions: readonly ApplyTransaction[]): AppliedItem[] {
  const out: AppliedItem[] = [];
  for (const tx of transactions) {
    for (const item of tx.items) {
      out.push({ id: item.id, title: item.title, category: item.category, original: item.original, replacement: item.replacement, at: tx.at, reverted: tx.revertedIds.includes(item.id), transactionId: tx.id });
    }
  }
  return out;
}

function renderApplied(state: PanelState, actions: PanelActions, items: AppliedItem[], latest?: ApplyTransaction): HTMLElement | null {
  if (items.length === 0) return null;
  const collapsed = state.collapsed.applied === true;
  const undoCount = latest ? latest.appliedIds.filter((id) => !latest.revertedIds.includes(id)).length : items.length;
  const header = h(
    'div',
    { class: 'jm-group-header' },
    h(
      'button',
      { type: 'button', class: 'jm-group-toggle', 'aria-expanded': String(!collapsed), onclick: () => actions.toggleGroup('applied'), dataset: { focusKey: 'group:applied' } },
      icon(collapsed ? 'chevron-right' : 'chevron-down'),
      h('span', { class: 'jm-group-title' }, 'Recently applied'),
      h('span', { class: 'jm-group-count' }, String(items.length)),
    ),
    undoCount > 0 ? button({ kind: 'ghost', size: 'sm', icon: 'undo', label: `Undo all ${undoCount}`, onClick: () => actions.undo(latest?.id), focusKey: 'applied:undo' }) : null,
  );
  const section = h('section', { class: ['jm-group', 'jm-group-applied', collapsed ? 'is-collapsed' : null], 'aria-label': 'Recently applied' }, header);
  if (!collapsed) {
    const list = h('ul', { class: 'jm-applied-list' });
    for (const item of items) {
      const reverted = item.reverted === true;
      list.appendChild(
        h(
          'li',
          { class: ['jm-applied-item', reverted ? 'is-reverted' : null], dataset: { appliedId: item.id } },
          h('div', { class: 'jm-applied-main' }, h('div', { class: 'jm-applied-title' }, categoryDot(item.category, CATEGORY_LABELS[item.category]), h('span', null, item.title)), h('div', { class: 'jm-diff-inline' }, h('s', { class: 'jm-original' }, visibleText(truncate(item.original, 60))), h('span', { class: 'jm-arrow', 'aria-hidden': 'true' }, '→'), h('span', { class: 'jm-replacement-text' }, visibleText(truncate(item.replacement, 60))))),
          reverted ? chip('Reverted', 'jm-chip-muted') : button({ kind: 'ghost', size: 'sm', label: 'Revert', onClick: () => actions.revert(item.id), focusKey: `revert:${item.id}` }),
        ),
      );
    }
    section.appendChild(list);
  }
  return section;
}

// ---------------------------------------------------------------------------
// Suggestion groups and cards
// ---------------------------------------------------------------------------

function renderGroups(state: PanelState, actions: PanelActions, suggestions: readonly Suggestion[]): HTMLElement {
  const wrap = h('div', { class: 'jm-groups' });
  const groups = groupByCategory(suggestions);
  for (const group of groups) {
    const collapsed = state.collapsed[group.category] === true;
    const confirming = state.ui.confirmDismissAll === group.category;
    const header = h(
      'div',
      { class: 'jm-group-header' },
      h(
        'button',
        { type: 'button', class: 'jm-group-toggle', 'aria-expanded': String(!collapsed), onclick: () => actions.toggleGroup(group.category), dataset: { focusKey: `group:${group.category}` } },
        icon(collapsed ? 'chevron-right' : 'chevron-down'),
        categoryDot(group.category),
        h('span', { class: 'jm-group-title' }, CATEGORY_LABELS[group.category]),
        h('span', { class: 'jm-group-count', title: group.items.length > 99 ? String(group.items.length) : undefined }, formatBadge(group.items.length)),
      ),
      confirming
        ? null
        : button({ kind: 'ghost', size: 'sm', icon: 'trash', label: `Dismiss all ${CATEGORY_LABELS[group.category].toLowerCase()} suggestions`, iconOnly: true, onClick: () => actions.requestDismissAll(group.category), focusKey: `dismiss-all:${group.category}` }),
    );
    const section = h('section', { class: ['jm-group', `jm-group-${group.category}`, collapsed ? 'is-collapsed' : null], 'aria-label': CATEGORY_LABELS[group.category], dataset: { category: group.category } }, header);
    if (confirming) {
      section.appendChild(inlineConfirm({ message: `Dismiss all ${plural(group.items.length, `${CATEGORY_LABELS[group.category].toLowerCase()} suggestion`)}?`, confirmLabel: 'Dismiss all', danger: true, onConfirm: () => actions.confirmDismissAll(), onCancel: () => actions.cancelDismissAll() }));
    }
    if (!collapsed) {
      const list = h('div', { class: 'jm-cards', role: 'list' });
      for (const s of group.items) list.appendChild(renderCard(state, actions, s));
      section.appendChild(list);
    }
    wrap.appendChild(section);
  }
  return wrap;
}

function tierChip(s: Suggestion): HTMLElement | null {
  if (s.stale) return chip('Sentence changed', 'jm-chip-stale');
  if (s.tier === 'A') return chip('Auto', 'jm-chip-auto');
  if (s.kind === 'rewrite') return chip('Rewrite', 'jm-chip-rewrite');
  return null;
}

export function renderCard(state: PanelState, actions: PanelActions, s: Suggestion): HTMLElement {
  const focused = state.ui.focusedId === s.id;
  const card = h('article', {
    class: ['jm-card', `jm-card-${s.category}`, focused ? 'is-focused' : null, s.stale ? 'is-stale' : null],
    role: 'listitem',
    tabindex: '0',
    'aria-label': `${CATEGORY_LABELS[s.category]}: ${s.title}`,
    dataset: { suggestionId: s.id, focusKey: `card:${s.id}`, tier: s.tier, rule: s.rule },
  });
  card.addEventListener('focus', () => actions.setFocused(s.id));
  card.addEventListener('click', (ev) => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (target?.closest('button, a, input, label, .jm-menu')) return;
    actions.focusSuggestion(s.id);
  });

  const head = h('div', { class: 'jm-card-head' }, categoryDot(s.category), h('span', { class: 'jm-card-category' }, CATEGORY_LABELS[s.category]), h('span', { class: 'jm-card-title' }, s.title), tierChip(s));
  card.appendChild(head);
  card.appendChild(renderDiff(actions, s));

  if (s.explanation) {
    const long = s.explanation.length > 140;
    const expanded = state.ui.expanded.includes(s.id);
    const p = h('p', { class: 'jm-card-explanation' }, long && !expanded ? truncate(s.explanation, 140) : s.explanation);
    if (long) p.appendChild(button({ kind: 'link', size: 'sm', label: expanded ? 'Less' : 'Learn more', onClick: () => actions.toggleExpanded(s.id) }));
    card.appendChild(p);
  }

  const menu = state.ui.menu && state.ui.menu.suggestionId === s.id ? state.ui.menu.kind : null;
  const acts = h('div', { class: 'jm-card-actions' });
  if (s.kind !== 'flag') acts.appendChild(button({ kind: 'primary', size: 'sm', label: 'Accept', onClick: () => actions.accept(s.id), focusKey: `accept:${s.id}` }));
  acts.appendChild(
    h(
      'div',
      { class: 'jm-split' },
      button({ kind: 'secondary', size: 'sm', label: 'Dismiss', onClick: () => actions.dismiss(s.id), focusKey: `dismiss:${s.id}` }),
      button({ kind: 'secondary', size: 'sm', icon: 'chevron-down', label: 'Dismiss with a reason', iconOnly: true, class: 'jm-menu-trigger', ariaExpanded: menu === 'dismiss', ariaHaspopup: 'menu', onClick: () => actions.openMenu('dismiss', s.id), focusKey: `dismiss-menu:${s.id}` }),
    ),
  );
  if (isSpellingRule(s.rule)) acts.appendChild(button({ kind: 'ghost', size: 'sm', icon: 'book', label: 'Add to dictionary', onClick: () => actions.addToDictionary(s.id), focusKey: `dict:${s.id}` }));
  acts.appendChild(button({ kind: 'ghost', size: 'sm', icon: 'more', label: 'More', iconOnly: true, class: 'jm-menu-trigger', ariaExpanded: menu === 'more', ariaHaspopup: 'menu', onClick: () => actions.openMenu('more', s.id), focusKey: `more:${s.id}` }));
  card.appendChild(acts);

  if (menu === 'dismiss') {
    card.appendChild(
      h(
        'div',
        { class: 'jm-menu', role: 'menu', 'aria-label': 'Dismiss reason' },
        DISMISS_REASONS.map((r) => h('button', { type: 'button', role: 'menuitem', class: 'jm-menu-item', onclick: () => actions.dismiss(s.id, r.reason), dataset: { reason: r.reason } }, r.label)),
      ),
    );
  } else if (menu === 'more') {
    const host = isScratchView(state) ? null : currentField(state)?.host ?? null;
    card.appendChild(
      h(
        'div',
        { class: 'jm-menu', role: 'menu', 'aria-label': 'More actions' },
        host ? h('button', { type: 'button', role: 'menuitem', class: 'jm-menu-item', onclick: () => actions.muteRule(s.id, 'host'), dataset: { mute: 'host' } }, `Turn off this rule on ${host}`) : null,
        h('button', { type: 'button', role: 'menuitem', class: 'jm-menu-item', onclick: () => actions.muteRule(s.id, 'global'), dataset: { mute: 'global' } }, 'Turn off this rule everywhere'),
      ),
    );
  }
  return card;
}

function renderDiff(actions: PanelActions, s: Suggestion): HTMLElement {
  const diff = h('div', { class: 'jm-card-diff' });
  switch (s.kind) {
    case 'flag':
      diff.appendChild(h('span', { class: 'jm-flagged' }, s.original));
      break;
    case 'rewrite': {
      diff.appendChild(h('s', { class: 'jm-original jm-sentence' }, s.original));
      const options = [s.replacement, ...s.alternatives].slice(0, 9);
      const list = h('ol', { class: 'jm-alternatives', 'aria-label': 'Rewrite options' });
      options.forEach((option, index) => {
        list.appendChild(
          h(
            'li',
            null,
            h(
              'button',
              { type: 'button', class: 'jm-replacement jm-alternative', onclick: () => actions.accept(s.id, index), dataset: { alternative: String(index), focusKey: `alt:${s.id}:${index}` }, 'aria-label': `Option ${index + 1}: ${option}` },
              h('span', { class: 'jm-alt-number', 'aria-hidden': 'true' }, String(index + 1)),
              h('span', { class: 'jm-alt-text' }, option),
            ),
          ),
        );
      });
      diff.appendChild(list);
      break;
    }
    case 'delete':
      diff.append(h('s', { class: 'jm-original' }, visibleText(s.original)), h('span', { class: 'jm-arrow', 'aria-hidden': 'true' }, '→'), h('button', { type: 'button', class: 'jm-replacement jm-remove', onclick: () => actions.accept(s.id), dataset: { focusKey: `repl:${s.id}` } }, 'Remove'));
      break;
    case 'insert':
      diff.append(h('span', { class: 'jm-insert-label' }, 'Insert'), h('button', { type: 'button', class: 'jm-replacement', onclick: () => actions.accept(s.id), dataset: { focusKey: `repl:${s.id}` }, 'aria-label': `Insert ${s.replacement}` }, visibleText(s.replacement)));
      break;
    case 'replace':
    default:
      diff.append(h('s', { class: 'jm-original' }, visibleText(s.original)), h('span', { class: 'jm-arrow', 'aria-hidden': 'true' }, '→'), h('button', { type: 'button', class: 'jm-replacement', onclick: () => actions.accept(s.id), dataset: { focusKey: `repl:${s.id}` }, 'aria-label': `Replace with ${s.replacement}` }, visibleText(s.replacement)));
  }
  return diff;
}

// ---------------------------------------------------------------------------
// Scratch ("Check text")
// ---------------------------------------------------------------------------

function renderScratch(state: PanelState, actions: PanelActions, view: PanelView): HTMLElement {
  const sc = state.scratch;
  const section = h('section', { class: 'jm-scratch', 'aria-label': 'Check text' });
  if (state.fieldOrder.length === 0) {
    section.appendChild(emptyState({ icon: 'panel', title: 'Focus a text field to see suggestions', body: 'Jammarly follows the field you are typing in. You can also paste text below to check it here, then copy the corrected version back.' }));
  }
  section.appendChild(h('h2', { class: 'jm-section-title' }, 'Check text'));
  if (!view.scratchTextarea) {
    const area = h('textarea', { class: 'jm-scratch-input', rows: '7', placeholder: 'Paste or type text to check…', 'aria-label': 'Text to check', spellcheck: 'false', dataset: { focusKey: 'scratch:text' } });
    area.addEventListener('input', () => {
      actions.scratchSetText(area.value);
    });
    view.scratchTextarea = area;
  }
  if (view.scratchTextarea.value !== sc.text) view.scratchTextarea.value = sc.text;
  section.appendChild(view.scratchTextarea);
  const hasText = sc.text.trim().length > 0;
  section.appendChild(
    h(
      'div',
      { class: 'jm-scratch-actions' },
      button({ kind: 'primary', label: sc.checking ? 'Checking…' : 'Check', icon: sc.checking ? 'spinner' : 'sparkle', disabled: !hasText || sc.checking, onClick: () => actions.scratchCheck(), focusKey: 'scratch:check' }),
      button({ kind: 'secondary', label: 'Copy corrected text', icon: 'copy', disabled: !hasText, onClick: () => void actions.scratchCopy(), focusKey: 'scratch:copy' }),
      button({ kind: 'ghost', label: 'Undo', icon: 'undo', disabled: sc.history.length === 0, onClick: () => actions.scratchUndo(), focusKey: 'scratch:undo' }),
      button({ kind: 'ghost', label: 'Clear', disabled: !hasText && sc.suggestions.length === 0, onClick: () => actions.scratchClear(), focusKey: 'scratch:clear' }),
    ),
  );
  if (sc.checkedOnce || sc.checking || sc.error) {
    const suggestions = visibleSuggestions(sc.suggestions, state.categories);
    const status = h('div', { class: 'jm-status', role: 'status', 'aria-live': 'polite' });
    if (sc.checking) status.append(icon('spinner', { class: 'jm-spin' }), h('span', null, 'Checking with the deep pass…'));
    else if (sc.error) {
      status.classList.add('is-error');
      renderError(status, actions, sc.error);
    } else if (suggestions.length === 0) {
      status.classList.add('is-clean');
      status.append(icon('check'), h('span', null, 'Looks good'));
    } else status.append(h('span', null, plural(suggestions.length, 'suggestion')));
    section.appendChild(
      fragment(
        renderSummary(sc.score?.overall ?? null, sc.score?.wordCount ?? 0, sc.score?.readingTimeSeconds ?? null, sc.text.length >= TONE_MIN_CHARS ? sc.tone : null),
        renderFilterChips(state, actions, sc.suggestions),
        renderAcceptAllBar(state, actions, suggestions),
        status,
        renderApplied(state, actions, sc.applied),
        renderGroups(state, actions, suggestions),
      ),
    );
  }
  return section;
}

// ---------------------------------------------------------------------------
// Footer and dialogs
// ---------------------------------------------------------------------------

function renderFooter(state: PanelState, actions: PanelActions): HTMLElement {
  const today = state.usage?.today.costUsd ?? null;
  return h(
    'footer',
    { class: 'jm-footer' },
    h('span', { class: 'jm-cost', title: 'Estimated cost of today’s checks on this device' }, today === null ? 'Today: –' : `Today ${formatUsdPrecise(today)}`),
    button({ kind: 'secondary', size: 'sm', icon: 'refresh', label: 'Check now', onClick: () => actions.recheck(), focusKey: 'footer:recheck' }),
  );
}

function renderGoalsDialog(state: PanelState, actions: PanelActions, host: string | null): HTMLElement {
  const dialog = state.ui.dialog;
  const draft = normalizeGoals(dialog?.goals);
  const scope = dialog?.scope ?? 'global';
  const overlay = h('div', { class: 'jm-overlay', onclick: (ev: Event) => ev.target === overlay && actions.closeDialog() });
  const box = h(
    'div',
    { class: 'jm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'jm-goals-title' },
    h('div', { class: 'jm-dialog-head' }, h('h2', { id: 'jm-goals-title', class: 'jm-dialog-title' }, 'Set goals'), button({ kind: 'ghost', icon: 'x', label: 'Close', iconOnly: true, onClick: () => actions.closeDialog() })),
    goalControl('Audience', segmented({ options: AUDIENCES, value: draft.audience, ariaLabel: 'Audience', focusKeyPrefix: 'goal:audience', onChange: (v) => actions.updateGoalsDraft({ audience: v }) })),
    goalControl('Formality', segmented({ options: FORMALITIES, value: draft.formality, ariaLabel: 'Formality', focusKeyPrefix: 'goal:formality', onChange: (v) => actions.updateGoalsDraft({ formality: v }) })),
    goalControl('Domain', segmented({ options: DOMAINS, value: draft.domain, ariaLabel: 'Domain', focusKeyPrefix: 'goal:domain', onChange: (v) => actions.updateGoalsDraft({ domain: v }) })),
    goalControl('Intent', segmented({ options: INTENTS, value: draft.intent, ariaLabel: 'Intent', focusKeyPrefix: 'goal:intent', onChange: (v) => actions.updateGoalsDraft({ intent: v }) })),
    host ? switchControl({ checked: scope === 'host', label: `For ${host} only`, description: 'Otherwise these goals apply everywhere.', focusKey: 'goal:scope', onChange: (on) => actions.updateGoalsDraft({}, on ? 'host' : 'global') }) : null,
    h('div', { class: 'jm-dialog-actions' }, button({ kind: 'ghost', label: 'Cancel', onClick: () => actions.closeDialog() }), button({ kind: 'primary', label: 'Done', onClick: () => actions.saveGoals(), focusKey: 'goal:done' })),
  );
  overlay.appendChild(box);
  return overlay;
}

function goalControl(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'jm-goal' }, h('div', { class: 'jm-goal-label' }, label), control);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
