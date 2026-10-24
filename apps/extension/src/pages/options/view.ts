/**
 * Options page rendering: left nav + one section at a time. Pure DOM from OptionsState.
 */
import type { Dialect, EngineMode, SuggestionCategory, WritingGoals } from '@jammarly/shared/types';
import { CATEGORIES } from '@jammarly/shared/types';
import { DEFAULT_RULE_TITLE, titleForRule } from '@jammarly/shared/prompts/vocabulary';
import { extensionId, extensionVersion, isDevBuild } from '../common/env';
import { h, replaceChildren, uid, type Child } from '../common/dom';
import { formatDateTime, formatUsd, relativeTime } from '../common/format';
import { brandMark, icon } from '../common/icons';
import { recentRpcErrors } from '../common/rpc';
import { safeHttpUrl } from '../common/guards';
import { CATEGORY_LABELS } from '../common/theme';
import { button, categoryDot, fieldRow, inlineConfirm, select, switchControl, type ToastHandle } from '../common/ui';
import { CUSTOM_INSTRUCTIONS_MAX, DEBOUNCE_MAX, DEBOUNCE_MIN, MODEL_CHOICES, ROUTES, consentMissing, liveValues, type OptionsActions, type OptionsState, type Route } from './app';

const NAV_LABELS: Record<Route, string> = {
  welcome: 'Welcome',
  general: 'Settings',
  style: 'Writing style',
  sites: 'Sites',
  dictionary: 'Dictionary',
  advanced: 'Advanced',
};

const SECTION_TITLES: Record<Route, string> = {
  welcome: 'Welcome to Jammarly',
  general: 'Settings',
  style: 'Your writing style',
  sites: 'Sites',
  dictionary: 'Personal dictionary',
  advanced: 'Advanced',
};

const MODE_OPTIONS: { value: EngineMode; label: string; description: string }[] = [
  { value: 'hybrid', label: 'Hybrid', description: 'A fast pass while you type, a deep pass when you pause. Best balance of speed and cost.' },
  { value: 'quality', label: 'Quality', description: 'Deep pass only. The most thorough suggestions; roughly 5× the cost of economy.' },
  { value: 'economy', label: 'Economy', description: 'Fast pass only. Cheapest and quickest; fewer nuanced style suggestions.' },
];

const DIALECTS: { value: Dialect; label: string }[] = [
  { value: 'en-US', label: 'American English' },
  { value: 'en-GB', label: 'British English' },
  { value: 'en-CA', label: 'Canadian English' },
  { value: 'en-AU', label: 'Australian English' },
  { value: 'en-IN', label: 'Indian English' },
];

const GOAL_OPTIONS: { key: keyof WritingGoals; label: string; options: { value: string; label: string }[] }[] = [
  { key: 'audience', label: 'Audience', options: [{ value: 'general', label: 'General' }, { value: 'knowledgeable', label: 'Knowledgeable' }, { value: 'expert', label: 'Expert' }] },
  { key: 'formality', label: 'Formality', options: [{ value: 'informal', label: 'Informal' }, { value: 'neutral', label: 'Neutral' }, { value: 'formal', label: 'Formal' }] },
  { key: 'domain', label: 'Domain', options: [{ value: 'general', label: 'General' }, { value: 'academic', label: 'Academic' }, { value: 'business', label: 'Business' }, { value: 'email', label: 'Email' }, { value: 'casual', label: 'Casual' }, { value: 'creative', label: 'Creative' }, { value: 'technical', label: 'Technical' }] },
  { key: 'intent', label: 'Intent', options: [{ value: 'inform', label: 'Inform' }, { value: 'describe', label: 'Describe' }, { value: 'convince', label: 'Convince' }, { value: 'tell_a_story', label: 'Tell a story' }] },
];

export function renderOptions(root: HTMLElement, state: OptionsState, actions: OptionsActions, toast: ToastHandle): void {
  root.classList.add('jm-options');
  const nav = renderNav(state, actions);
  const main = h('main', { class: 'jm-main', id: 'jm-main' });
  main.appendChild(h('h1', { class: 'jm-page-title' }, SECTION_TITLES[state.route]));
  if (state.workerError) {
    main.appendChild(h('div', { class: 'jm-notice jm-notice-error', role: 'alert' }, icon('alert'), h('span', null, state.workerError), button({ kind: 'link', size: 'sm', label: 'Retry', onClick: () => void actions.reload() })));
  }
  main.appendChild(renderSection(state, actions));
  main.appendChild(toast.element);
  replaceChildren(root, nav, main);
}

function renderNav(state: OptionsState, actions: OptionsActions): HTMLElement {
  const items = ROUTES.filter((r) => r !== 'welcome' || consentMissing(state.profile) || state.route === 'welcome');
  return h(
    'nav',
    { class: 'jm-nav', 'aria-label': 'Settings sections' },
    h('div', { class: 'jm-nav-brand' }, brandMark(24), h('span', { class: 'jm-brand-name' }, 'Jammarly')),
    h(
      'ul',
      { class: 'jm-nav-list' },
      items.map((route) =>
        h(
          'li',
          null,
          h(
            'a',
            {
              href: `#${route}`,
              class: ['jm-nav-link', state.route === route ? 'is-active' : null],
              'aria-current': state.route === route ? 'page' : undefined,
              dataset: { route, focusKey: `nav:${route}` },
              onclick: (ev: Event) => {
                ev.preventDefault();
                actions.navigate(route);
              },
            },
            NAV_LABELS[route],
            route === 'welcome' && consentMissing(state.profile) ? h('span', { class: 'jm-nav-badge' }, '1') : null,
          ),
        ),
      ),
    ),
    h('div', { class: 'jm-nav-foot' }, `Version ${extensionVersion() || '–'}`),
  );
}

function renderSection(state: OptionsState, actions: OptionsActions): HTMLElement {
  switch (state.route) {
    case 'welcome':
      return renderWelcome(state, actions);
    case 'general':
      return renderGeneral(state, actions);
    case 'style':
      return renderStyle(state, actions);
    case 'sites':
      return renderSites(state, actions);
    case 'dictionary':
      return renderDictionary(state, actions);
    case 'advanced':
      return renderAdvanced(state, actions);
  }
}

function card(title: string | null, ...children: Child[]): HTMLElement {
  return h('section', { class: 'jm-card-block' }, title ? h('h2', { class: 'jm-card-title' }, title) : null, ...children);
}

function helpText(...children: Child[]): HTMLElement {
  return h('p', { class: 'jm-help' }, ...children);
}

function textInput(opts: { key: string; actions: OptionsActions; placeholder?: string; type?: string; ariaLabel?: string; fallback?: string; onEnter?: () => void; maxLength?: number; autocomplete?: string; inputMode?: string }): HTMLInputElement {
  const input = h('input', {
    type: opts.type ?? 'text',
    class: 'jm-input',
    placeholder: opts.placeholder,
    'aria-label': opts.ariaLabel,
    value: opts.actions.draft(opts.key, opts.fallback ?? ''),
    maxlength: opts.maxLength ? String(opts.maxLength) : undefined,
    autocomplete: opts.autocomplete ?? 'off',
    inputmode: opts.inputMode,
    dataset: { focusKey: `input:${opts.key}` },
  });
  input.addEventListener('input', () => {
    opts.actions.setDraft(opts.key, input.value);
    opts.actions.clearError(opts.key);
  });
  if (opts.onEnter) {
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        opts.onEnter?.();
      }
    });
  }
  return input;
}

function listWithRemove(items: string[], onRemove: (value: string) => void, emptyText: string, kind: string): HTMLElement {
  if (items.length === 0) return h('p', { class: 'jm-list-empty' }, emptyText);
  return h(
    'ul',
    { class: 'jm-list', dataset: { list: kind } },
    items.map((value) => h('li', { class: 'jm-list-item', dataset: { value } }, h('span', { class: 'jm-list-value' }, value), button({ kind: 'ghost', size: 'sm', icon: 'x', label: `Remove ${value}`, iconOnly: true, onClick: () => onRemove(value), focusKey: `${kind}:remove:${value}` }))),
  );
}

// ---------------------------------------------------------------------------
// Welcome
// ---------------------------------------------------------------------------

function renderWelcome(state: OptionsState, actions: OptionsActions): HTMLElement {
  const profile = state.profile;
  const consentAt = profile?.settings.privacy.value.consentAt ?? null;
  const settings = state.settings;
  const wrap = h('div', { class: 'jm-welcome' });
  wrap.appendChild(
    h(
      'p',
      { class: 'jm-lead' },
      'Jammarly underlines problems in any text field, shows a one-click fix, and can accept every safe correction at once. It runs on your own Anthropic API key and learns the way you write.',
    ),
  );

  // Step 1: disclosure and consent
  wrap.appendChild(
    card(
      'Step 1 · How your text is handled',
      h(
        'p',
        { class: 'jm-disclosure' },
        'When Jammarly checks a field, the text in that field is sent to Anthropic over HTTPS using your own API key, and the suggestions come back to this browser. Nothing is sent until you finish this page and agree below. Quick local checks (spacing, repeated words, capitalization) always stay on this device, and you can turn Jammarly off for any site from the toolbar popup.',
      ),
      consentAt
        ? h('div', { class: 'jm-consent-done' }, icon('check'), h('span', null, `You agreed on ${formatDateTime(consentAt)}.`))
        : button({ kind: 'primary', label: 'I agree and continue', onClick: () => void actions.agree(), disabled: state.busy.agree === true, focusKey: 'welcome:agree' }),
    ),
  );

  // Step 2: key or pairing
  const keyErr = state.errors.apiKey ?? null;
  const keyInput = textInput({ key: 'apiKey', actions, type: 'password', placeholder: 'sk-ant-…', ariaLabel: 'Anthropic API key', autocomplete: 'off', onEnter: () => void actions.saveApiKey(keyInput.value) });
  const testResult = renderKeyTest(state);
  const pairingInput = textInput({ key: 'pairingId', actions, placeholder: 'Pairing id', ariaLabel: 'Pairing id' });
  const codeInput = textInput({ key: 'pairCode', actions, placeholder: '6-digit code', ariaLabel: 'Pairing code', inputMode: 'numeric', maxLength: 6, onEnter: () => void actions.pair(pairingInput.value, codeInput.value) });
  wrap.appendChild(
    card(
      'Step 2 · Connect an engine',
      h(
        'div',
        { class: 'jm-two-col' },
        h(
          'div',
          { class: 'jm-col' },
          h('h3', { class: 'jm-sub-title' }, 'Use your own API key'),
          helpText('The key is stored only on this device and is never shown again or synced.'),
          fieldRow({ label: 'API key', control: keyInput, error: keyErr, hint: settings?.hasApiKey ? (state.keySavedHint ? `A key is saved (ends with ${state.keySavedHint}).` : 'A key is saved on this device.') : 'No key saved yet.' }),
          h(
            'div',
            { class: 'jm-actions' },
            button({ kind: 'primary', label: 'Save key', onClick: () => void actions.saveApiKey(keyInput.value), disabled: state.busy.apiKey === true, focusKey: 'welcome:save-key' }),
            button({ kind: 'secondary', label: state.keyTest.status === 'testing' ? 'Testing…' : 'Test key', onClick: () => void actions.testApiKey(keyInput.value), disabled: state.keyTest.status === 'testing', focusKey: 'welcome:test-key' }),
          ),
          testResult,
          isDevBuild()
            ? switchControl({ checked: settings?.provider === 'mock', label: 'Use the mock engine', description: 'Development builds only: deterministic suggestions, no network.', onChange: (on) => void actions.setMockProvider(on), focusKey: 'welcome:mock' })
            : null,
        ),
        h(
          'div',
          { class: 'jm-col' },
          h('h3', { class: 'jm-sub-title' }, 'Or pair with the web app'),
          helpText('Open the dashboard, choose “Pair a device” and type the id and code here. Pairing syncs your goals, dictionary and learned preferences; you still need a key on this device.'),
          fieldRow({ label: 'Pairing id', control: pairingInput }),
          fieldRow({ label: 'Code', control: codeInput, error: state.errors.pair ?? null }),
          h('div', { class: 'jm-actions' }, button({ kind: 'secondary', label: state.busy.pair ? 'Pairing…' : 'Pair', onClick: () => void actions.pair(pairingInput.value, codeInput.value), disabled: state.busy.pair === true, focusKey: 'welcome:pair' })),
          settings?.paired ? h('div', { class: 'jm-consent-done' }, icon('check'), h('span', null, `Paired with ${settings.appOrigin ?? 'the web app'}.`)) : null,
        ),
      ),
    ),
  );

  // Step 3: default sites
  const choice = state.defaultSites;
  const radioName = uid('sites');
  const radio = (value: 'everywhere' | 'opt-in', label: string, description: string): HTMLElement => {
    const id = uid('radio');
    return h(
      'label',
      { class: ['jm-radio', choice === value ? 'is-selected' : null], for: id },
      h('input', { type: 'radio', id, name: radioName, value, checked: choice === value, onchange: () => void actions.chooseDefaultSites(value), dataset: { focusKey: `welcome:sites:${value}` } }),
      h('span', { class: 'jm-radio-body' }, h('span', { class: 'jm-radio-title' }, label), h('span', { class: 'jm-radio-desc' }, description)),
    );
  };
  wrap.appendChild(
    card(
      'Step 3 · Where to check',
      radio('everywhere', 'Check everywhere', 'Jammarly checks every text field on the web. Turn individual sites off from the toolbar popup.'),
      radio('opt-in', 'Only sites I turn on', 'Fields that sites marked as “no spellcheck” stay untouched, and you switch sites on one by one from the popup (the switch next to the site name).'),
    ),
  );

  wrap.appendChild(h('div', { class: 'jm-actions jm-actions-end' }, button({ kind: 'primary', label: 'Finish', icon: 'check', onClick: () => actions.finishWelcome(), focusKey: 'welcome:finish' })));
  return wrap;
}

function renderKeyTest(state: OptionsState): HTMLElement | null {
  const t = state.keyTest;
  if (t.status === 'idle') return null;
  if (t.status === 'testing') return h('div', { class: 'jm-test-result', role: 'status' }, icon('spinner', { class: 'jm-spin' }), h('span', null, 'Testing your key…'));
  return h(
    'div',
    { class: ['jm-test-result', t.valid ? 'is-valid' : 'is-invalid'], role: 'status', dataset: { valid: String(t.valid === true) } },
    icon(t.valid ? 'check' : 'alert'),
    h('span', null, t.valid ? `Key works${t.model ? ` (${t.model})` : ''}.` : t.message || 'The key was rejected.'),
    t.valid && t.message ? h('span', { class: 'jm-test-note' }, t.message) : null,
  );
}

// ---------------------------------------------------------------------------
// General
// ---------------------------------------------------------------------------

function renderGeneral(state: OptionsState, actions: OptionsActions): HTMLElement {
  const settings = state.settings;
  const profile = state.profile;
  const wrap = h('div', { class: 'jm-stack' });
  const disabled = !settings;

  wrap.appendChild(
    card(
      null,
      switchControl({ checked: settings?.enabled ?? true, label: 'Check my writing', description: 'Turn Jammarly off everywhere without uninstalling it.', disabled, onChange: (on) => void actions.setDeviceSetting({ enabled: on }), focusKey: 'general:enabled' }),
    ),
  );

  const categories = profile?.settings.categories.value ?? { correctness: true, clarity: true, engagement: true, delivery: true };
  wrap.appendChild(
    card(
      'What to check',
      CATEGORIES.map((category: SuggestionCategory) =>
        h(
          'div',
          { class: 'jm-category-row' },
          categoryDot(category),
          switchControl({ checked: categories[category] !== false, label: CATEGORY_LABELS[category], description: CATEGORY_DESCRIPTIONS[category], disabled: !profile, onChange: (on) => void actions.setCategories({ ...categories, [category]: on }), focusKey: `category:${category}` }),
        ),
      ),
    ),
  );

  wrap.appendChild(
    card(
      'Look',
      switchControl({ checked: settings?.showUnderlines ?? true, label: 'Underline suggestions', description: 'Turn off to see suggestions only in the side panel.', disabled, onChange: (on) => void actions.setDeviceSetting({ showUnderlines: on }), focusKey: 'general:underlines' }),
      switchControl({ checked: settings?.showFloatingButton ?? true, label: 'Show the Jammarly button', description: 'The small button in the corner of the box you are typing in. It spins while checking.', disabled, onChange: (on) => void actions.setDeviceSetting({ showFloatingButton: on }), focusKey: 'general:button' }),
      switchControl({ checked: settings?.colorblindMode ?? false, label: 'Colorblind-friendly colors', description: 'High-contrast colors with a different underline pattern for each kind of suggestion.', disabled, onChange: (on) => void actions.setDeviceSetting({ colorblindMode: on }), focusKey: 'general:colorblind' }),
    ),
  );

  // Account: key and spending in one place.
  const keyInput = textInput({ key: 'apiKey', actions, type: 'password', placeholder: 'Paste a new key', ariaLabel: 'Anthropic API key', onEnter: () => void actions.saveApiKey(keyInput.value) });
  const budgetInput = h('input', { type: 'number', class: 'jm-input jm-input-sm', min: '0', step: '0.5', value: actions.draft('dailyBudgetUsd', String(settings?.dailyBudgetUsd ?? 2)), disabled, 'aria-label': 'Daily budget in US dollars', dataset: { focusKey: 'general:budget' } });
  budgetInput.addEventListener('input', () => {
    actions.setDraft('dailyBudgetUsd', budgetInput.value);
    actions.clearError('dailyBudgetUsd');
  });
  const saveBudget = (): void => void actions.saveBudget(budgetInput.value);
  budgetInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') saveBudget();
  });
  const usage = state.usage;
  wrap.appendChild(
    card(
      'Account',
      fieldRow({ label: 'Anthropic API key', control: keyInput, error: state.errors.apiKey ?? null, hint: settings?.hasApiKey ? (state.keySavedHint ? `A key is saved (ends with ${state.keySavedHint}). Paste a new one to replace it.` : 'A key is saved. Paste a new one to replace it.') : 'No key saved yet.' }),
      h(
        'div',
        { class: 'jm-actions' },
        button({ kind: 'primary', size: 'sm', label: 'Save key', onClick: () => void actions.saveApiKey(keyInput.value), disabled: state.busy.apiKey === true, focusKey: 'general:save-key' }),
        button({ kind: 'secondary', size: 'sm', label: state.keyTest.status === 'testing' ? 'Testing…' : 'Test key', onClick: () => void actions.testApiKey(keyInput.value), disabled: state.keyTest.status === 'testing', focusKey: 'general:test-key' }),
      ),
      renderKeyTest(state),
      fieldRow({
        label: 'Daily spending limit',
        hint: 'Jammarly slows down to cheaper checks when today reaches this amount. 0 means no limit.',
        control: h('div', { class: 'jm-inline-controls' }, h('span', { class: 'jm-prefix' }, '$'), budgetInput, button({ kind: 'secondary', size: 'sm', label: 'Save', onClick: saveBudget, disabled, focusKey: 'general:budget-save' })),
        error: state.errors.dailyBudgetUsd ?? null,
      }),
      h('dl', { class: 'jm-usage' }, h('dt', null, 'Today'), h('dd', { dataset: { usage: 'today' } }, usage ? `${formatUsd(usage.today.costUsd)} · ${usage.today.requests} requests` : '–'), h('dt', null, 'This month'), h('dd', { dataset: { usage: 'month' } }, usage ? `${formatUsd(usage.month.costUsd)} · ${usage.month.requests} requests` : '–')),
    ),
  );

  wrap.appendChild(renderShortcuts(state, actions));
  return wrap;
}

/** Engine mode, models and check delay: Advanced only. */
function renderEngine(state: OptionsState, actions: OptionsActions): HTMLElement {
  const settings = state.settings;
  const profile = state.profile;
  const paired = settings?.paired === true;
  const disabled = !settings;
  const mode = paired ? profile?.settings.mode.value ?? settings?.mode ?? 'hybrid' : settings?.mode ?? 'hybrid';
  const model = paired ? profile?.settings.model.value ?? settings?.model ?? '' : settings?.model ?? '';
  const fastModel = paired ? profile?.settings.fastModel.value ?? settings?.fastModel ?? '' : settings?.fastModel ?? '';
  const modeGroup = h(
    'div',
    { class: 'jm-mode-list', role: 'radiogroup', 'aria-label': 'Engine mode' },
    MODE_OPTIONS.map((opt) => {
      const id = uid('mode');
      return h(
        'label',
        { class: ['jm-radio', mode === opt.value ? 'is-selected' : null], for: id },
        h('input', { type: 'radio', id, name: 'mode', value: opt.value, checked: mode === opt.value, disabled, onchange: () => void actions.setEngineSetting('mode', opt.value), dataset: { focusKey: `general:mode:${opt.value}` } }),
        h('span', { class: 'jm-radio-body' }, h('span', { class: 'jm-radio-title' }, opt.label), h('span', { class: 'jm-radio-desc' }, opt.description)),
      );
    }),
  );
  const debounce = settings?.debounceMs ?? 700;
  const slider = h('input', { type: 'range', class: 'jm-range', min: String(DEBOUNCE_MIN), max: String(DEBOUNCE_MAX), step: '50', value: String(Math.min(DEBOUNCE_MAX, Math.max(DEBOUNCE_MIN, debounce))), disabled, 'aria-label': 'Delay before checking', dataset: { focusKey: 'general:debounce' } });
  const sliderValue = h('span', { class: 'jm-range-value' }, `${debounce} ms`);
  slider.addEventListener('input', () => {
    sliderValue.textContent = `${slider.value} ms`;
  });
  slider.addEventListener('change', () => void actions.setDeviceSetting({ debounceMs: Number(slider.value) }));
  return card(
    'Engine',
    paired ? h('p', { class: 'jm-note' }, icon('info'), h('span', null, 'Mode and models are synced across devices while paired.')) : null,
    modeGroup,
    modelField('Deep-pass model', 'model', model, state, actions, disabled),
    modelField('Fast-pass model', 'fastModel', fastModel, state, actions, disabled),
    fieldRow({ label: 'Delay before checking', hint: 'How long to wait after you stop typing. Shorter is snappier; longer is cheaper.', control: h('div', { class: 'jm-range-row' }, slider, sliderValue) }),
  );
}

function renderShortcuts(state: OptionsState, actions: OptionsActions): HTMLElement {
  const rows = state.shortcuts;
  return card(
    'Keyboard shortcuts',
    helpText('Chrome keeps extension shortcuts on its own page. Open it, find Jammarly, and click the pencil next to a command to set any key, for example one for Accept everything.'),
    rows && rows.length > 0
      ? h(
          'dl',
          { class: 'jm-usage', dataset: { shortcuts: 'list' } },
          rows.flatMap((r) => [h('dt', null, r.description), h('dd', { dataset: { shortcut: r.name } }, r.shortcut ? h('kbd', null, r.shortcut) : 'Not set')]),
        )
      : null,
    h('div', { class: 'jm-actions' }, button({ kind: 'secondary', label: 'Change shortcuts', onClick: () => void actions.openShortcutSettings(), focusKey: 'general:shortcuts' })),
  );
}

function modelField(label: string, key: 'model' | 'fastModel', current: string, state: OptionsState, actions: OptionsActions, disabled: boolean): HTMLElement {
  const known = (MODEL_CHOICES as readonly string[]).includes(current);
  const draftKey = `${key}:custom`;
  // Unknown (empty) values mean the settings have not loaded; keep the preset view rather than an empty custom box.
  const customOpen = actions.draft(`${key}:mode`, known || current === '' ? 'preset' : 'custom') === 'custom';
  const options = [...MODEL_CHOICES.map((m) => ({ value: m, label: m })), { value: '__custom__', label: 'Custom…' }];
  const sel = select<string>({
    options,
    value: customOpen ? '__custom__' : current,
    ariaLabel: label,
    disabled,
    focusKey: `general:${key}`,
    onChange: (value) => {
      if (value === '__custom__') {
        actions.setDraft(`${key}:mode`, 'custom');
        actions.setDraft(draftKey, actions.draft(draftKey, current));
        // Re-render through a no-op state touch is unnecessary: show the input right away.
        wrapper.appendChild(customRow());
        sel.value = '__custom__';
        return;
      }
      actions.setDraft(`${key}:mode`, 'preset');
      void actions.setEngineSetting(key, value);
    },
  });
  const customRow = (): HTMLElement => {
    const input = textInput({ key: draftKey, actions, placeholder: 'model id', ariaLabel: `${label} id`, fallback: current, onEnter: () => void actions.setEngineSetting(key, input.value) });
    return h('div', { class: 'jm-inline-controls jm-custom-model' }, input, button({ kind: 'secondary', size: 'sm', label: 'Use', onClick: () => void actions.setEngineSetting(key, input.value), focusKey: `general:${key}:use` }));
  };
  const wrapper = h('div', { class: 'jm-model-field' }, sel);
  if (customOpen) wrapper.appendChild(customRow());
  return fieldRow({ label, control: wrapper, error: state.errors[key] ?? null, hint: key === 'model' ? 'Used for the thorough pass when you pause.' : 'Used while you type.' });
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

function renderStyle(state: OptionsState, actions: OptionsActions): HTMLElement {
  const profile = state.profile;
  const settings = state.settings;
  const wrap = h('div', { class: 'jm-stack' });
  const disabled = !profile || !settings;
  const savedOwner = settings?.styleOwner ?? '';
  const savedStyle = profile?.settings.customInstructions.value ?? '';
  const owner = textInput({ key: 'styleOwner', actions, placeholder: 'Your name', ariaLabel: 'Whose writing style', fallback: savedOwner, maxLength: 80 });
  const draft = actions.draft('customInstructions', savedStyle);
  const area = h('textarea', {
    class: 'jm-textarea jm-style-text',
    rows: '12',
    maxlength: String(CUSTOM_INSTRUCTIONS_MAX + 500),
    placeholder: 'How you write, in plain words. For example:\nShort, direct sentences. Friendly but not gushing.\nNever use em dashes; use commas or periods instead.\nSign off with just my first name.',
    'aria-label': 'Writing style',
    disabled,
    dataset: { focusKey: 'customInstructions' },
  });
  area.value = draft;
  const counter = h('span', { class: ['jm-counter', draft.length > CUSTOM_INSTRUCTIONS_MAX ? 'is-over' : null] }, `${draft.length} / ${CUSTOM_INSTRUCTIONS_MAX}`);
  area.addEventListener('input', () => {
    actions.setDraft('customInstructions', area.value);
    counter.textContent = `${area.value.length} / ${CUSTOM_INSTRUCTIONS_MAX}`;
    counter.classList.toggle('is-over', area.value.length > CUSTOM_INSTRUCTIONS_MAX);
    actions.clearError('customInstructions');
  });
  const fileInput = h('input', { type: 'file', accept: '.json,.txt,application/json,text/plain', class: 'jm-file', 'aria-label': 'Import a writing style', dataset: { focusKey: 'style:import' } });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const read = typeof file.text === 'function' ? file.text() : new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.readAsText(file);
    });
    void read.then((text) => actions.importWritingStyle(text));
    fileInput.value = '';
  });
  const whose = savedOwner ? `${savedOwner}’s` : 'Your';
  wrap.appendChild(
    card(
      `${whose} style`,
      helpText('Jammarly shapes every suggestion to sound like the person described here, and leaves alone the habits that are part of that style. It also keeps learning from what you accept and dismiss.'),
      fieldRow({ label: 'Whose style is this?', control: owner }),
      fieldRow({ label: 'How they write', control: area, error: state.errors.customInstructions ?? null }),
      h('div', { class: 'jm-actions jm-actions-split' }, counter, button({ kind: 'primary', size: 'sm', label: 'Save style', onClick: () => void actions.saveWritingStyle(owner.value, area.value), disabled, focusKey: 'style:save' })),
    ),
  );
  wrap.appendChild(
    card(
      'Share or switch',
      helpText('Each person keeps their own style. Export saves this one to a file. Someone else using Jammarly can import theirs, or reset to start from a blank style.'),
      h(
        'div',
        { class: 'jm-actions' },
        button({ kind: 'secondary', size: 'sm', icon: 'download', label: 'Export', onClick: () => void actions.exportWritingStyle(), disabled: savedStyle.length === 0, focusKey: 'style:export' }),
        h('label', { class: 'jm-btn jm-btn-secondary jm-btn-sm jm-file-label' }, icon('upload'), h('span', { class: 'jm-btn-label' }, 'Import'), fileInput),
        state.confirm === 'reset-style' ? null : button({ kind: 'danger', size: 'sm', label: 'Reset', onClick: () => actions.requestResetStyle(), disabled: disabled || (savedStyle.length === 0 && savedOwner.length === 0), focusKey: 'style:reset' }),
      ),
      state.confirm === 'reset-style'
        ? inlineConfirm({ message: `Clear ${savedOwner ? `${savedOwner}’s` : 'this'} writing style? Export it first if you want to keep it.`, confirmLabel: 'Reset', danger: true, onConfirm: () => void actions.confirmResetStyle(), onCancel: () => actions.cancelConfirm() })
        : null,
    ),
  );
  wrap.appendChild(
    card(
      'Language',
      fieldRow({ label: 'English', control: select<Dialect>({ options: DIALECTS, value: profile?.settings.dialect.value ?? 'en-US', ariaLabel: 'English dialect', disabled: !profile, focusKey: 'dialect', onChange: (v) => void actions.setDialect(v) }) }),
    ),
  );
  return wrap;
}

/** Goals and muted rules: Advanced only. */
function renderGoals(state: OptionsState, actions: OptionsActions): HTMLElement[] {
  const profile = state.profile;
  const disabled = !profile;
  const goals: WritingGoals = profile?.settings.goals.value ?? { audience: 'general', formality: 'neutral', domain: 'general', intent: 'inform' };
  const out: HTMLElement[] = [
    card(
      'Goals',
      helpText('Default goals for every site. The side panel can override them for a single site.'),
      h(
        'div',
        { class: 'jm-grid-2' },
        GOAL_OPTIONS.map((g) =>
          fieldRow({
            label: g.label,
            control: select<string>({ options: g.options, value: goals[g.key], ariaLabel: g.label, disabled, focusKey: `goals:${g.key}`, onChange: (value) => void actions.setGoals({ ...goals, [g.key]: value } as WritingGoals) }),
          }),
        ),
      ),
    ),
  ];
  const muted = liveValues(profile?.rules.muted);
  if (muted.length > 0) {
    out.push(
      card(
        'Muted rules',
        helpText('Rules you turned off from a card (“Turn off this rule everywhere”). Unmute to see them again.'),
        h(
          'ul',
          { class: 'jm-list', dataset: { list: 'muted' } },
          muted.map((rule) => h('li', { class: 'jm-list-item', dataset: { value: rule } }, h('span', { class: 'jm-list-value' }, ruleTitle(rule), h('span', { class: 'jm-list-sub' }, rule)), button({ kind: 'secondary', size: 'sm', label: 'Unmute', onClick: () => void actions.unmuteRule(rule), focusKey: `muted:${rule}` }))),
        ),
      ),
    );
  }
  return out;
}

const CATEGORY_DESCRIPTIONS: Record<SuggestionCategory, string> = {
  correctness: 'Spelling, grammar and punctuation.',
  clarity: 'Wordy phrases and sentences that are hard to follow.',
  engagement: 'Livelier word choices.',
  delivery: 'Tone: how polite, confident or formal you sound.',
};

/** Title for a rule id; falls back to the id when the vocabulary has no entry. */
export function ruleTitle(rule: string): string {
  const title = titleForRule(rule);
  return title === DEFAULT_RULE_TITLE && rule !== 'other' ? rule : title;
}

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

function renderSites(state: OptionsState, actions: OptionsActions): HTMLElement {
  const profile = state.profile;
  const disabledHosts = liveValues(profile?.sites.disabled);
  const ignoreOptOut = profile?.settings.ignoreOptOutHosts.value ?? [];
  const wrap = h('div', { class: 'jm-stack' });
  const addDisabled = textInput({ key: 'disabledSite', actions, placeholder: 'mail.google.com', ariaLabel: 'Site to turn off', onEnter: () => void actions.addDisabledSite(addDisabled.value) });
  wrap.appendChild(
    card(
      'Sites where Jammarly is off',
      helpText('Jammarly never attaches to fields on these sites. The toolbar popup toggles the current site too.'),
      fieldRow({ label: 'Add a site', control: h('div', { class: 'jm-inline-controls' }, addDisabled, button({ kind: 'secondary', size: 'sm', icon: 'plus', label: 'Add', onClick: () => void actions.addDisabledSite(addDisabled.value), focusKey: 'sites:add-disabled' })), error: state.errors.disabledSite ?? null }),
      listWithRemove(disabledHosts, (host) => void actions.removeDisabledSite(host), 'Jammarly is on everywhere.', 'disabled'),
    ),
  );
  return wrap;
}

/** Sites whose writing-assistant opt-out Jammarly ignores: Advanced only. */
function renderSiteExceptions(state: OptionsState, actions: OptionsActions): HTMLElement {
  const profile = state.profile;
  const ignoreOptOut = profile?.settings.ignoreOptOutHosts.value ?? [];
  const wrap = h('div', { class: 'jm-stack' });
  const addIgnore = textInput({ key: 'ignoreOptOutHost', actions, placeholder: 'app.slack.com', ariaLabel: 'Site to check anyway', onEnter: () => void actions.addIgnoreOptOutHost(addIgnore.value) });
  wrap.appendChild(
    card(
      'Check here anyway',
      helpText('Some sites ask writing assistants to stay out of their fields. Jammarly honours that unless the site is listed here.'),
      fieldRow({ label: 'Add a site', control: h('div', { class: 'jm-inline-controls' }, addIgnore, button({ kind: 'secondary', size: 'sm', icon: 'plus', label: 'Add', onClick: () => void actions.addIgnoreOptOutHost(addIgnore.value), focusKey: 'sites:add-ignore' })), error: state.errors.ignoreOptOutHost ?? null }),
      listWithRemove(ignoreOptOut, (host) => void actions.removeIgnoreOptOutHost(host), 'No overrides.', 'ignore-opt-out'),
      switchControl({ checked: profile?.settings.checkOptedOutFields.value ?? false, label: 'Check opted-out fields everywhere', description: 'Ignore every site’s opt-out attribute. Use the list above for a few sites instead.', disabled: !profile, onChange: (on) => void actions.setCheckOptedOutFields(on), focusKey: 'sites:check-opted-out' }),
    ),
  );
  return wrap.firstElementChild as HTMLElement;
}

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

function renderDictionary(state: OptionsState, actions: OptionsActions): HTMLElement {
  const words = liveValues(state.profile?.dictionary);
  const wrap = h('div', { class: 'jm-stack' });
  const input = textInput({ key: 'word', actions, placeholder: 'Add a word', ariaLabel: 'Word to add', onEnter: () => void actions.addWord(input.value) });
  const fileInput = h('input', { type: 'file', accept: '.txt,text/plain', class: 'jm-file', 'aria-label': 'Import a word list', dataset: { focusKey: 'dictionary:import' } });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const read = typeof file.text === 'function' ? file.text() : new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.readAsText(file);
    });
    void read.then((text) => actions.importDictionary(text));
    fileInput.value = '';
  });
  wrap.appendChild(
    card(
      null,
      helpText('Words here are never flagged as misspelled. “Add to dictionary” on a spelling card adds to this list, and it syncs when paired.'),
      fieldRow({ label: 'Add a word', control: h('div', { class: 'jm-inline-controls' }, input, button({ kind: 'secondary', size: 'sm', icon: 'plus', label: 'Add', onClick: () => void actions.addWord(input.value), focusKey: 'dictionary:add' })), error: state.errors.word ?? null }),
      h('div', { class: 'jm-actions' }, button({ kind: 'secondary', size: 'sm', icon: 'download', label: 'Export', onClick: () => void actions.exportDictionary(), disabled: words.length === 0, focusKey: 'dictionary:export' }), h('label', { class: 'jm-btn jm-btn-secondary jm-btn-sm jm-file-label' }, icon('upload'), h('span', { class: 'jm-btn-label' }, 'Import'), fileInput)),
      h('p', { class: 'jm-count-line' }, `${words.length} ${words.length === 1 ? 'word' : 'words'}`),
      listWithRemove(words, (word) => void actions.removeWord(word), 'Your dictionary is empty.', 'dictionary'),
    ),
  );
  return wrap;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function renderSync(state: OptionsState, actions: OptionsActions): HTMLElement {
  const settings = state.settings;
  const sync = state.sync;
  const paired = settings?.paired === true;
  const wrap = h('div', { class: 'jm-stack' });
  if (paired) {
    wrap.appendChild(
      card(
        'This device is paired',
        h(
          'dl',
          { class: 'jm-kv' },
          h('dt', null, 'Web app'),
          h('dd', null, settings?.appOrigin ? (safeHttpUrl(settings.appOrigin) ? h('a', { href: safeHttpUrl(settings.appOrigin), target: '_blank', rel: 'noopener noreferrer', class: 'jm-link' }, settings.appOrigin, icon('external', { size: 14 })) : h('span', { class: 'jm-mono' }, settings.appOrigin)) : '–'),
          h('dt', null, 'Device id'),
          h('dd', { class: 'jm-mono' }, state.pairedDeviceId ?? '–'),
          h('dt', null, 'Status'),
          h('dd', { dataset: { sync: 'status' } }, sync ? syncStatusCopy(sync.status) : 'Unknown'),
          h('dt', null, 'Profile version'),
          h('dd', null, sync ? String(sync.version) : '–'),
          h('dt', null, 'Last poll'),
          h('dd', null, relativeTime(sync?.lastPollAt)),
          h('dt', null, 'Last push'),
          h('dd', null, relativeTime(sync?.lastPushAt)),
          h('dt', null, 'Last event upload'),
          h('dd', null, relativeTime(sync?.lastEventUploadAt)),
          h('dt', null, 'Pending changes'),
          h('dd', null, sync ? String(sync.pendingOps.length) : '–'),
        ),
        h(
          'div',
          { class: 'jm-actions' },
          button({ kind: 'primary', size: 'sm', icon: 'refresh', label: state.busy.sync ? 'Syncing…' : 'Sync now', onClick: () => void actions.syncNow(), disabled: state.busy.sync === true, focusKey: 'sync:now' }),
          state.confirm === 'unpair' ? null : button({ kind: 'danger', size: 'sm', label: 'Unpair', onClick: () => actions.requestUnpair(), disabled: state.busy.unpair === true, focusKey: 'sync:unpair' }),
        ),
        state.confirm === 'unpair' ? inlineConfirm({ message: 'Unpair this device? Your settings stay here but stop syncing.', confirmLabel: 'Unpair', danger: true, onConfirm: () => void actions.confirmUnpair(), onCancel: () => actions.cancelConfirm() }) : null,
      ),
    );
  } else {
    const pairingInput = textInput({ key: 'pairingId', actions, placeholder: 'Pairing id', ariaLabel: 'Pairing id' });
    const codeInput = textInput({ key: 'pairCode', actions, placeholder: '6-digit code', ariaLabel: 'Pairing code', inputMode: 'numeric', maxLength: 6, onEnter: () => void actions.pair(pairingInput.value, codeInput.value) });
    wrap.appendChild(
      card(
        'Not paired',
        helpText('Pair with the Jammarly web app to sync goals, dictionary, muted rules and what Jammarly learned across your devices. Your API key never syncs.'),
        fieldRow({ label: 'Pairing id', control: pairingInput }),
        fieldRow({ label: 'Code', control: codeInput, error: state.errors.pair ?? null }),
        h('div', { class: 'jm-actions' }, button({ kind: 'primary', label: state.busy.pair ? 'Pairing…' : 'Pair', onClick: () => void actions.pair(pairingInput.value, codeInput.value), disabled: state.busy.pair === true, focusKey: 'sync:pair' })),
      ),
    );
  }
  return wrap;
}

function syncStatusCopy(status: string): string {
  switch (status) {
    case 'ok':
      return 'Up to date';
    case 'offline':
      return 'Offline';
    case 'paused':
      return 'Paused (quota)';
    case 'revoked':
      return 'Access revoked';
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

function renderPrivacy(state: OptionsState, actions: OptionsActions): HTMLElement {
  const profile = state.profile;
  const privacy = profile?.settings.privacy.value ?? { storeSnippets: true, retentionDays: 90 as const, learningEnabled: true, consentAt: null };
  const settings = state.settings;
  const paired = settings?.paired === true;
  const disabled = !profile;
  const wrap = h('div', { class: 'jm-stack' });

  wrap.appendChild(
    card(
      'Learning',
      switchControl({ checked: privacy.learningEnabled, label: 'Learn from what I accept and dismiss', description: 'Builds a voice profile and tunes which suggestions you see.', disabled, onChange: (on) => void actions.setPrivacy({ learningEnabled: on }), focusKey: 'privacy:learning' }),
      switchControl({ checked: privacy.storeSnippets, label: 'Store short text snippets with feedback', description: 'Up to 200 redacted characters around each decision. Off keeps only counts.', disabled, onChange: (on) => void actions.setPrivacy({ storeSnippets: on }), focusKey: 'privacy:snippets' }),
      fieldRow({ label: 'Keep feedback for', control: select<string>({ options: [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: 'A year' }], value: String(privacy.retentionDays), ariaLabel: 'Retention', disabled, focusKey: 'privacy:retention', onChange: (v) => void actions.setPrivacy({ retentionDays: Number(v) as 30 | 90 | 365 }) }) }),
    ),
  );

  wrap.appendChild(
    card(
      'Consent',
      privacy.consentAt
        ? h(
            'div',
            null,
            h('p', { class: 'jm-help' }, `You agreed to send checked text to Anthropic with your own key on ${formatDateTime(privacy.consentAt)}.`),
            state.confirm === 'withdraw'
              ? inlineConfirm({ message: 'Withdraw consent? Checking stops immediately until you agree again on the Welcome page.', confirmLabel: 'Withdraw', danger: true, onConfirm: () => void actions.confirmWithdraw(), onCancel: () => actions.cancelConfirm() })
              : button({ kind: 'danger', size: 'sm', label: 'Withdraw consent', onClick: () => actions.requestWithdraw(), disabled, focusKey: 'privacy:withdraw' }),
          )
        : h('p', { class: 'jm-help' }, 'No consent recorded. Nothing is sent to Anthropic until you agree on the ', h('a', { href: '#welcome', class: 'jm-link', onclick: (ev: Event) => { ev.preventDefault(); actions.navigate('welcome'); } }, 'Welcome page'), '.'),
    ),
  );

  const privateInput = textInput({ key: 'privateSite', actions, placeholder: 'mail.example.com', ariaLabel: 'Private site', onEnter: () => void actions.addPrivateSite(privateInput.value) });
  wrap.appendChild(
    card(
      'Private sites',
      helpText('Snippets are never stored for feedback from these sites (suffix match), even when snippet storage is on.'),
      fieldRow({ label: 'Add a site', control: h('div', { class: 'jm-inline-controls' }, privateInput, button({ kind: 'secondary', size: 'sm', icon: 'plus', label: 'Add', onClick: () => void actions.addPrivateSite(privateInput.value), focusKey: 'privacy:add-private' })), error: state.errors.privateSite ?? null }),
      listWithRemove(profile?.settings.privateSites.value ?? [], (host) => void actions.removePrivateSite(host), 'No private sites.', 'private'),
    ),
  );

  const dashboard = paired ? safeHttpUrl(settings?.appOrigin) : null;
  wrap.appendChild(
    card(
      'Your data',
      dashboard
        ? h(
            'div',
            { class: 'jm-actions' },
            h('a', { class: 'jm-btn jm-btn-secondary jm-btn-sm', href: `${dashboard}/privacy`, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { class: 'jm-btn-label' }, 'Export my data')),
            h('a', { class: 'jm-btn jm-btn-danger jm-btn-sm', href: `${dashboard}/privacy`, target: '_blank', rel: 'noopener noreferrer' }, icon('trash'), h('span', { class: 'jm-btn-label' }, 'Delete learning data')),
          )
        : helpText('This device is not paired, so everything Jammarly learned lives only here. Removing the extension deletes it; pair with the web app to export or delete it from the dashboard.'),
    ),
  );
  return wrap;
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

function renderAdvanced(state: OptionsState, actions: OptionsActions): HTMLElement {
  const settings = state.settings;
  const wrap = h('div', { class: 'jm-stack' });
  wrap.appendChild(h('p', { class: 'jm-lead' }, 'Most people never need these. The defaults are tuned for speed and cost.'));
  wrap.appendChild(renderEngine(state, actions));
  for (const el of renderGoals(state, actions)) wrap.appendChild(el);
  wrap.appendChild(renderSiteExceptions(state, actions));
  for (const el of Array.from(renderPrivacy(state, actions).children)) wrap.appendChild(el);
  for (const el of Array.from(renderSync(state, actions).children)) wrap.appendChild(el);
  wrap.appendChild(
    card(
      'Google Docs',
      helpText('Google Docs draws text on a canvas, so inline underlines need Docs’ own extension hook. Jammarly layers its support: the side panel’s “Check text” always works (paste, check, accept all, copy back); inline underlines turn on only when Docs exposes the hook for this extension; and “Off” never touches Docs inline.'),
      fieldRow({
        label: 'Inline mode',
        control: select<'auto' | 'off'>({ options: [{ value: 'auto', label: 'Auto (when Docs allows it)' }, { value: 'off', label: 'Off' }], value: settings?.gdocsInline ?? 'auto', ariaLabel: 'Google Docs inline mode', disabled: !settings, focusKey: 'advanced:gdocs', onChange: (v) => void actions.setDeviceSetting({ gdocsInline: v }) }),
      }),
    ),
  );
  const info = { id: extensionId(), version: extensionVersion() };
  wrap.appendChild(
    card(
      'About this install',
      h('dl', { class: 'jm-kv' }, h('dt', null, 'Extension id'), h('dd', { class: 'jm-mono', dataset: { info: 'id' } }, info.id || '–'), h('dt', null, 'Version'), h('dd', { dataset: { info: 'version' } }, info.version || '–'), h('dt', null, 'Provider'), h('dd', null, settings?.provider ?? '–')),
      h('div', { class: 'jm-actions' }, button({ kind: 'secondary', size: 'sm', icon: 'panel', label: 'Open side panel', onClick: () => void actions.openSidePanel(), focusKey: 'advanced:open-panel' })),
    ),
  );
  const errors = recentRpcErrors();
  wrap.appendChild(
    card(
      'Debug',
      h('h3', { class: 'jm-sub-title' }, 'Last error'),
      state.lastError ? h('pre', { class: 'jm-debug', dataset: { debug: 'last-error' } }, `${formatDateTime(state.lastError.at)}\n${state.lastError.message}`) : h('p', { class: 'jm-list-empty' }, 'No errors since this page opened.'),
      h('h3', { class: 'jm-sub-title' }, 'Recent worker replies that failed'),
      errors.length === 0 ? h('p', { class: 'jm-list-empty' }, 'None.') : h('pre', { class: 'jm-debug' }, errors.map((e) => `${e.at}  ${e.request}  ${e.code}: ${e.message}`).join('\n')),
    ),
  );
  return wrap;
}
