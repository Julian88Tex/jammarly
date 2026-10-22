/**
 * Toolbar popup: master switch, per-site switch, setup notice, the active field's summary, and shortcuts to the
 * review panel and settings. Everything comes from the worker (RuntimeRequests plus a short-lived panel port for
 * the field list); the popup never touches storage.
 */
import type { EffectiveConfig, FieldState, PublicDeviceSettings, SyncState, UsageTotals } from '@jammarly/shared/types';
import { CATEGORIES } from '@jammarly/shared/types';
import { chromeApi, openOptionsPage } from '../common/env';
import { h, preserveFocus, replaceChildren } from '../common/dom';
import { formatUsd, hostFromUrl, plural, relativeTime } from '../common/format';
import { coerceFieldState, coerceSettings, formatBadge } from '../common/guards';
import { brandMark, icon } from '../common/icons';
import { connectPanelPort, type PanelPort } from '../common/port';
import { describeFailure, pick, request } from '../common/rpc';
import { createStore, type Store } from '../common/store';
import { CATEGORY_LABELS, watchTheme } from '../common/theme';
import { button, categoryDot, createToastHost, switchControl, type ToastHandle } from '../common/ui';

export interface PopupState {
  loading: boolean;
  settings: PublicDeviceSettings | null;
  config: EffectiveConfig | null;
  usage: UsageTotals | null;
  sync: SyncState | null;
  tabId: number | null;
  host: string | null;
  hostEnabled: boolean | null;
  field: FieldState | null;
  fieldsInTab: number;
  /** Worker unreachable or answering garbage. */
  workerError: string | null;
}

export interface PopupActions {
  setEnabled(on: boolean): Promise<void>;
  setHostEnabled(on: boolean): Promise<void>;
  openPanel(): Promise<void>;
  openSettings(): void;
  finishSetup(): void;
  reload(): Promise<void>;
}

export interface PopupApp {
  store: Store<PopupState>;
  actions: PopupActions;
  port: PanelPort;
  toast: ToastHandle;
  ready: Promise<void>;
  dispose(): void;
}

export function initialPopupState(): PopupState {
  return { loading: true, settings: null, config: null, usage: null, sync: null, tabId: null, host: null, hostEnabled: null, field: null, fieldsInTab: 0, workerError: null };
}

export function mountPopup(root: HTMLElement, opts: { closeWindow?: () => void } = {}): PopupApp {
  const store = createStore<PopupState>(initialPopupState());
  const toast = createToastHost();
  const closeWindow = opts.closeWindow ?? (() => window.close());
  let disposed = false;

  const port = connectPanelPort({ onOpen: (p) => p.send({ type: 'hello', role: 'sidepanel' }), backoffMs: [1000, 3000, 10_000] });
  port.onMessage((msg) => {
    if (msg.type === 'fields') {
      const fields: FieldState[] = [];
      if (Array.isArray(msg.fields)) {
        for (const raw of msg.fields) {
          const f = coerceFieldState(raw);
          if (f) fields.push(f);
        }
      }
      store.update((s) => pickField(s, fields));
    } else if (msg.type === 'field-state') {
      const f = coerceFieldState(msg.state);
      if (!f) return;
      store.update((s) => {
        if (s.tabId !== null && f.tabId !== s.tabId) return s;
        if (s.field && s.field.fieldId !== f.fieldId && !f.active) return s;
        return { ...s, field: f };
      });
    } else if (msg.type === 'field-removed') {
      if (typeof msg.fieldId !== 'string') return;
      store.update((s) => (s.field && s.field.fieldId === msg.fieldId ? { ...s, field: null, fieldsInTab: Math.max(0, s.fieldsInTab - 1) } : s));
    } else if (msg.type === 'config') {
      const settings = coerceSettings(msg.settings);
      const sync = msg.sync && typeof msg.sync === 'object' && typeof msg.sync.status === 'string' ? msg.sync : null;
      store.update((s) => ({ ...s, config: msg.config && typeof msg.config === 'object' ? msg.config : s.config, settings: settings ?? s.settings, sync: msg.sync === undefined ? s.sync : sync }));
    }
  });

  function pickField(s: PopupState, fields: FieldState[]): PopupState {
    const inTab = s.tabId === null ? fields : fields.filter((f) => f.tabId === s.tabId);
    const field = inTab.find((f) => f.active) ?? inTab[0] ?? null;
    return { ...s, field, fieldsInTab: inTab.length };
  }

  async function activeTab(): Promise<{ id: number | null; host: string | null }> {
    const api = chromeApi();
    if (!api?.tabs?.query) return { id: null, host: null };
    try {
      const tabs = await Promise.resolve(api.tabs.query({ active: true, currentWindow: true }));
      const tab = Array.isArray(tabs) ? tabs[0] : undefined;
      return { id: typeof tab?.id === 'number' ? tab.id : null, host: hostFromUrl(tab?.url) };
    } catch {
      return { id: null, host: null };
    }
  }

  async function load(): Promise<void> {
    const tab = await activeTab();
    store.update((s) => ({ ...s, tabId: tab.id, host: tab.host }));
    const [settingsRes, usageRes, syncRes, hostRes] = await Promise.all([
      request({ type: 'get-settings' }),
      request({ type: 'get-usage' }),
      request({ type: 'get-sync-state' }),
      tab.host ? request({ type: 'get-host-status', host: tab.host }) : Promise.resolve(null),
    ]);
    if (disposed) return;
    const settings = pick(settingsRes, 'settings');
    const usage = pick(usageRes, 'usage');
    const sync = pick(syncRes, 'sync-state');
    const hostStatus = hostRes ? pick(hostRes, 'host-status') : null;
    const safeSettings = settings ? coerceSettings(settings.settings) : null;
    store.update((s) => ({
      ...s,
      loading: false,
      settings: safeSettings ?? s.settings,
      usage: usage?.usage && typeof usage.usage === 'object' ? usage.usage : s.usage,
      sync: sync ? sync.sync : s.sync,
      hostEnabled: hostStatus ? hostStatus.enabled === true : s.hostEnabled,
      workerError: settings ? null : settingsRes.ok ? 'Unexpected answer from the extension.' : describeFailure(settingsRes),
    }));
  }

  const actions: PopupActions = {
    async setEnabled(on) {
      store.update((s) => (s.settings ? { ...s, settings: { ...s.settings, enabled: on } } : s));
      const res = await request({ type: 'set-settings', patch: { enabled: on } });
      if (disposed) return;
      if (!res.ok) {
        toast.show(describeFailure(res), { tone: 'error' });
        store.update((s) => (s.settings ? { ...s, settings: { ...s.settings, enabled: !on } } : s));
        return;
      }
      const settings = pick(res, 'settings');
      const safe = settings ? coerceSettings(settings.settings) : null;
      if (safe) store.update((s) => ({ ...s, settings: safe }));
    },
    async setHostEnabled(on) {
      const host = store.get().host;
      if (!host) return;
      store.update((s) => ({ ...s, hostEnabled: on }));
      const res = await request({ type: 'set-host-enabled', host, enabled: on });
      if (disposed) return;
      if (!res.ok) {
        toast.show(describeFailure(res), { tone: 'error' });
        store.update((s) => ({ ...s, hostEnabled: !on }));
      }
    },
    async openPanel() {
      // Must be sent from the click handler so the user gesture reaches chrome.sidePanel.open() in the worker.
      const res = await request({ type: 'open-side-panel' });
      if (disposed) return;
      if (!res.ok) {
        toast.show(describeFailure(res), { tone: 'error' });
        return;
      }
      closeWindow();
    },
    openSettings() {
      void openOptionsPage();
    },
    finishSetup() {
      void openOptionsPage('welcome');
    },
    reload: load,
  };

  const render = (): void => {
    if (disposed) return;
    preserveFocus(root, () => renderPopup(root, store.get(), actions, toast));
  };
  const unsubscribe = store.subscribe(render);
  const stopTheme = watchTheme(document.documentElement, () => ({ colorblind: store.get().settings?.colorblindMode === true }));
  render();
  const ready = load();

  return {
    store,
    actions,
    port,
    toast,
    ready,
    dispose() {
      disposed = true;
      unsubscribe();
      stopTheme();
      port.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function needsSetup(state: PopupState): boolean {
  const settings = state.settings;
  if (settings && !settings.hasApiKey && settings.provider !== 'mock') return true;
  if (state.config && state.config.consented === false) return true;
  return false;
}

export function syncLine(settings: PublicDeviceSettings | null, sync: SyncState | null, now = Date.now()): string {
  if (!settings?.paired) return 'Not paired';
  if (!sync) return 'Paired';
  switch (sync.status) {
    case 'paused':
      return 'Sync paused';
    case 'offline':
      return 'Offline';
    case 'revoked':
      return 'Device access revoked';
    default: {
      const last = [sync.lastPollAt, sync.lastPushAt].filter((t) => t && Number.isFinite(Date.parse(t))).sort().pop();
      return last ? `Synced ${relativeTime(last, now)}` : 'Paired';
    }
  }
}

export function costLine(usage: UsageTotals | null, settings: PublicDeviceSettings | null): string {
  const today = usage?.today.costUsd ?? 0;
  const budget = settings?.dailyBudgetUsd ?? 0;
  return budget > 0 ? `Today ${formatUsd(today)} of ${formatUsd(budget)}` : `Today ${formatUsd(today)}`;
}

function statusCopy(field: FieldState): string {
  switch (field.status) {
    case 'checking':
      return 'Checking…';
    case 'clean':
      return 'Looks good';
    case 'suggestions':
      return plural(field.suggestions.length, 'suggestion');
    case 'error':
      return field.error?.message || 'Error';
    case 'setup':
      return 'Setup needed';
    case 'off':
      return 'Off in this field';
    case 'unsupported':
      return 'Not supported';
    default:
      return field.wordCount > 0 ? 'Waiting for a pause' : 'Empty';
  }
}

function renderPopup(root: HTMLElement, state: PopupState, actions: PopupActions, toast: ToastHandle): void {
  root.classList.add('jm-popup');
  const enabled = state.settings?.enabled ?? true;
  const header = h(
    'header',
    { class: 'jm-popup-header' },
    h('div', { class: 'jm-brand' }, brandMark(22), h('span', { class: 'jm-brand-name' }, 'Jammarly')),
    switchControl({ checked: enabled, label: enabled ? 'Jammarly is on' : 'Jammarly is off', hideLabel: true, disabled: state.loading || !state.settings, focusKey: 'master', onChange: (on) => void actions.setEnabled(on) }),
  );

  const rows: (HTMLElement | null)[] = [header];

  if (state.workerError) {
    rows.push(h('div', { class: 'jm-notice jm-notice-error', role: 'alert' }, icon('alert'), h('span', null, state.workerError), button({ kind: 'link', size: 'sm', label: 'Retry', onClick: () => void actions.reload() })));
  }

  if (needsSetup(state)) {
    rows.push(h('div', { class: 'jm-notice jm-notice-setup' }, icon('sparkle'), h('div', { class: 'jm-notice-body' }, h('strong', null, 'Finish setting up Jammarly'), h('span', null, state.config && state.config.consented === false ? 'Review how your text is handled and add your key.' : 'Add your Anthropic API key or pair with the web app.')), button({ kind: 'primary', size: 'sm', label: 'Set up', onClick: () => actions.finishSetup(), focusKey: 'setup' })));
  }

  if (state.host) {
    const hostOn = state.hostEnabled ?? true;
    rows.push(h('div', { class: 'jm-row jm-host-row' }, switchControl({ checked: hostOn, label: `On ${state.host}`, description: hostOn ? 'Checking text on this site' : 'Paused on this site', disabled: !enabled || state.loading, focusKey: 'host', onChange: (on) => void actions.setHostEnabled(on) })));
  } else {
    rows.push(h('div', { class: 'jm-row jm-row-muted' }, icon('info'), h('span', null, state.loading ? 'Loading…' : 'Not available on this page')));
  }

  rows.push(renderField(state));

  rows.push(
    h(
      'div',
      { class: 'jm-popup-actions' },
      button({ kind: 'primary', icon: 'panel', label: 'Open review panel', onClick: () => void actions.openPanel(), focusKey: 'open-panel' }),
      button({ kind: 'secondary', icon: 'settings', label: 'Settings', onClick: () => actions.openSettings(), focusKey: 'settings' }),
    ),
  );

  rows.push(h('footer', { class: 'jm-popup-footer' }, h('span', { class: 'jm-sync-line' }, syncLine(state.settings, state.sync)), h('span', { class: 'jm-cost-line' }, costLine(state.usage, state.settings))));
  rows.push(toast.element);
  replaceChildren(root, ...rows);
}

function renderField(state: PopupState): HTMLElement {
  const field = state.field;
  if (!field) {
    return h('div', { class: 'jm-field-card jm-field-empty' }, h('span', { class: 'jm-field-title' }, state.host ? 'No text field focused' : 'Focus a text field to see suggestions'), h('span', { class: 'jm-field-sub' }, 'Click into a field on the page and Jammarly will start checking.'));
  }
  const counts: Record<string, number> = {};
  for (const s of field.suggestions) counts[s.category] = (counts[s.category] ?? 0) + 1;
  return h(
    'div',
    { class: 'jm-field-card', dataset: { fieldId: field.fieldId } },
    h('div', { class: 'jm-field-top' }, h('span', { class: 'jm-field-title' }, field.label || 'Text field'), h('span', { class: ['jm-field-status', `is-${field.status}`] }, statusCopy(field))),
    h(
      'div',
      { class: 'jm-field-counts' },
      CATEGORIES.map((category) => {
        const n = counts[category] ?? 0;
        return h('span', { class: ['jm-count', n === 0 ? 'is-zero' : null], title: n > 99 ? `${CATEGORY_LABELS[category]}: ${n}` : CATEGORY_LABELS[category], dataset: { category } }, categoryDot(category, CATEGORY_LABELS[category]), formatBadge(n));
      }),
    ),
    h('div', { class: 'jm-field-sub' }, plural(field.wordCount, 'word'), state.fieldsInTab > 1 ? ` · ${state.fieldsInTab} fields on this page` : ''),
  );
}
