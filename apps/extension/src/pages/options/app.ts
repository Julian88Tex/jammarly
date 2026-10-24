/**
 * Options page controller: hash router, data loading (get-settings / get-profile / get-usage / get-sync-state) and every
 * write (set-settings for device settings, profile-ops with hlc '' for profile fields). Rendering lives in ./view.
 */
import type { DeviceSettings, Dialect, ProfileDocument, PublicDeviceSettings, SuggestionCategory, SyncState, UsageTotals, WritingGoals } from '@jammarly/shared/types';
import type { LwwPath, OrSetElement, PrivacySettings, ProfileOp, SetPath } from '@jammarly/shared/profile';
import { chromeApi } from '../common/env';
import { preserveFocus } from '../common/dom';
import { normalizeHost } from '../common/format';
import { coerceProfile, coerceSettings, validKeyHint } from '../common/guards';
import { describeFailure, pick, request, type RpcFailure } from '../common/rpc';
import { createStore, type Store } from '../common/store';
import { watchTheme } from '../common/theme';
import { createToastHost, type ToastHandle } from '../common/ui';
import { renderOptions } from './view';

export const ROUTES = ['welcome', 'general', 'suggestions', 'sites', 'dictionary', 'sync', 'privacy', 'advanced'] as const;
export type Route = (typeof ROUTES)[number];

export const MODEL_CHOICES = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export const CUSTOM_INSTRUCTIONS_MAX = 2000;
export const DEBOUNCE_MIN = 300;
export const DEBOUNCE_MAX = 2000;

export interface KeyTestState {
  status: 'idle' | 'testing' | 'done';
  valid?: boolean;
  model?: string;
  message?: string;
}

export interface OptionsState {
  route: Route;
  loading: boolean;
  settings: PublicDeviceSettings | null;
  profile: ProfileDocument | null;
  usage: UsageTotals | null;
  sync: SyncState | null;
  workerError: string | null;
  pairedDeviceId: string | null;
  keyTest: KeyTestState;
  keySavedHint: string | null;
  confirm: 'unpair' | 'withdraw' | null;
  errors: Record<string, string>;
  busy: Record<string, boolean>;
  /** Welcome step 3 choice (kept so the radio stays put after a write). */
  defaultSites: 'everywhere' | 'opt-in' | null;
  /** Bumps when the page should scroll to the top (route change). */
  lastError: { at: string; message: string } | null;
  /** The extension's keyboard commands and their current keys; null until read (or where chrome.commands is missing). */
  shortcuts: ShortcutInfo[] | null;
}

export interface ShortcutInfo {
  name: string;
  description: string;
  /** Empty when no key is set. */
  shortcut: string;
}

/** Chrome only lets people change extension shortcuts on this page; an extension may open it. */
export const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

export type Drafts = Map<string, string>;

export interface OptionsActions {
  navigate(route: Route): void;
  reload(): Promise<void>;
  setDraft(key: string, value: string): void;
  draft(key: string, fallback?: string): string;
  clearError(key: string): void;
  // welcome
  agree(): Promise<void>;
  saveApiKey(key: string): Promise<boolean>;
  testApiKey(key: string): Promise<void>;
  setMockProvider(on: boolean): Promise<void>;
  pair(pairingId: string, code: string): Promise<boolean>;
  chooseDefaultSites(choice: 'everywhere' | 'opt-in'): Promise<void>;
  finishWelcome(): void;
  // general
  setDeviceSetting(patch: Partial<DeviceSettings>, label?: string): Promise<boolean>;
  /** Validates the typed budget ("0" = unlimited) and writes dailyBudgetUsd. */
  saveBudget(raw: string): Promise<boolean>;
  setEngineSetting(key: 'mode' | 'model' | 'fastModel', value: string): Promise<boolean>;
  // suggestions
  setGoals(goals: WritingGoals): Promise<boolean>;
  setDialect(dialect: Dialect): Promise<boolean>;
  setCategories(categories: Record<SuggestionCategory, boolean>): Promise<boolean>;
  saveCustomInstructions(text: string): Promise<boolean>;
  unmuteRule(rule: string): Promise<boolean>;
  // sites
  addDisabledSite(input: string): Promise<boolean>;
  removeDisabledSite(host: string): Promise<boolean>;
  addIgnoreOptOutHost(input: string): Promise<boolean>;
  removeIgnoreOptOutHost(host: string): Promise<boolean>;
  setCheckOptedOutFields(on: boolean): Promise<boolean>;
  // dictionary
  addWord(word: string): Promise<boolean>;
  removeWord(word: string): Promise<boolean>;
  exportDictionary(): string;
  importDictionary(text: string): Promise<number>;
  // sync
  requestUnpair(): void;
  confirmUnpair(): Promise<void>;
  cancelConfirm(): void;
  syncNow(): Promise<void>;
  // privacy
  setPrivacy(patch: Partial<PrivacySettings>): Promise<boolean>;
  requestWithdraw(): void;
  confirmWithdraw(): Promise<void>;
  addPrivateSite(input: string): Promise<boolean>;
  removePrivateSite(host: string): Promise<boolean>;
  // advanced
  openSidePanel(): Promise<void>;
  // shortcuts
  openShortcutSettings(): Promise<void>;
}

export interface OptionsApp {
  store: Store<OptionsState>;
  actions: OptionsActions;
  toast: ToastHandle;
  drafts: Drafts;
  ready: Promise<void>;
  dispose(): void;
}

export function initialOptionsState(route: Route = 'general'): OptionsState {
  return {
    route,
    loading: true,
    settings: null,
    profile: null,
    usage: null,
    sync: null,
    workerError: null,
    pairedDeviceId: null,
    keyTest: { status: 'idle' },
    keySavedHint: null,
    confirm: null,
    errors: {},
    busy: {},
    defaultSites: null,
    lastError: null,
    shortcuts: null,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value);
}

export function consentMissing(profile: ProfileDocument | null): boolean {
  return !profile || profile.settings.privacy.value.consentAt == null;
}

/** Route for a hash; invalid or empty hashes default to welcome while consent is missing, else general. */
export function routeFromHash(hash: string, profile: ProfileDocument | null): Route {
  const raw = hash.replace(/^#\/?/, '').trim().toLowerCase();
  if (isRoute(raw)) return raw;
  return consentMissing(profile) ? 'welcome' : 'general';
}

/** Live elements of an add-wins OR-set: removedHlc absent or addedHlc > removedHlc (fixed-width strings compare lexically). */
export function liveValues(elements: readonly OrSetElement<string>[] | undefined): string[] {
  if (!Array.isArray(elements)) return [];
  const out = new Set<string>();
  for (const el of elements) {
    if (!el || typeof el.value !== 'string') continue;
    if (el.removedHlc === undefined || el.addedHlc > el.removedHlc) out.add(el.value);
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

export function setOp(path: LwwPath, value: unknown): ProfileOp {
  return { op: 'set', path, value, hlc: '' };
}
export function addOp(path: SetPath, value: string): ProfileOp {
  return { op: 'add', path, value, hlc: '' };
}
export function removeOp(path: SetPath, value: string): ProfileOp {
  return { op: 'remove', path, value, hlc: '' };
}

/** Splits a newline (or comma) list of words into unique, trimmed entries. */
export function parseWordList(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\r\n,]+/)) {
    const w = raw.trim();
    if (w && !/\s/.test(w)) out.add(w);
  }
  return Array.from(out);
}

export function validateApiKey(key: string): string | null {
  const k = key.trim();
  if (!k) return 'Enter your API key.';
  if (k.length < 20 || /\s/.test(k)) return "That doesn't look like an API key.";
  return null;
}

export function validatePairing(pairingId: string, code: string): string | null {
  if (!pairingId.trim()) return 'Enter the pairing id shown in the web app.';
  if (!/^\d{6}$/.test(code.trim())) return 'The code is 6 digits.';
  return null;
}

/** Looks for a redacted key hint in a settings reply without widening the shared type (see validKeyHint for the rule). */
export function keyHintFrom(reply: unknown): string | null {
  if (!reply || typeof reply !== 'object') return null;
  const s = (reply as { settings?: unknown }).settings;
  if (!s || typeof s !== 'object') return null;
  return validKeyHint((s as { apiKeyHint?: unknown }).apiKeyHint);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export interface MountOptionsOpts {
  /** Hash source/sink; defaults to window.location. */
  getHash?: () => string;
  setHash?: (hash: string) => void;
  download?: (filename: string, text: string) => void;
}

export function mountOptions(root: HTMLElement, opts: MountOptionsOpts = {}): OptionsApp {
  const getHash = opts.getHash ?? (() => window.location.hash);
  const setHash = opts.setHash ?? ((hash: string) => {
    window.location.hash = hash;
  });
  const download = opts.download ?? downloadText;
  const store = createStore<OptionsState>(initialOptionsState(routeFromHash(getHash(), null)));
  const toast = createToastHost();
  const drafts: Drafts = new Map();
  let disposed = false;

  const setBusy = (key: string, on: boolean): void => store.update((s) => ({ ...s, busy: { ...s.busy, [key]: on } }));
  const setError = (key: string, message: string | null): void =>
    store.update((s) => {
      const errors = { ...s.errors };
      if (message) errors[key] = message;
      else delete errors[key];
      return { ...s, errors };
    });

  function fail(res: RpcFailure): false {
    const message = describeFailure(res);
    toast.show(message, { tone: 'error', durationMs: 6000 });
    store.update((s) => ({ ...s, lastError: { at: new Date().toISOString(), message: `${res.error.code}: ${res.error.message}` } }));
    return false;
  }

  async function reloadSettings(): Promise<void> {
    const res = await request({ type: 'get-settings' });
    if (disposed) return;
    const settings = pick(res, 'settings');
    const safe = settings ? coerceSettings(settings.settings) : null;
    store.update((s) => ({ ...s, settings: safe ?? s.settings, workerError: settings ? null : res.ok ? 'Unexpected answer from the extension.' : describeFailure(res) }));
  }

  async function reloadProfile(): Promise<void> {
    const res = await request({ type: 'get-profile' });
    if (disposed) return;
    const reply = pick(res, 'profile');
    const profile = reply ? coerceProfile(reply.profile) : null;
    if (profile) store.update((s) => ({ ...s, profile }));
  }

  async function reloadUsageAndSync(): Promise<void> {
    const [usageRes, syncRes] = await Promise.all([request({ type: 'get-usage' }), request({ type: 'get-sync-state' })]);
    if (disposed) return;
    const usage = pick(usageRes, 'usage');
    const sync = pick(syncRes, 'sync-state');
    store.update((s) => ({ ...s, usage: usage?.usage && typeof usage.usage === 'object' ? usage.usage : s.usage, sync: sync ? sync.sync : s.sync }));
  }

  async function reloadShortcuts(): Promise<void> {
    const shortcuts = await readShortcuts();
    if (disposed || shortcuts === null) return;
    store.update((s) => ({ ...s, shortcuts }));
  }

  async function load(): Promise<void> {
    await Promise.all([reloadSettings(), reloadProfile(), reloadUsageAndSync(), reloadShortcuts()]);
    if (disposed) return;
    store.update((s) => ({ ...s, loading: false, route: routeFromHash(getHash(), s.profile) }));
  }

  async function writeSettings(patch: Partial<DeviceSettings>, label = 'Saved'): Promise<boolean> {
    const res = await request({ type: 'set-settings', patch });
    if (disposed) return false;
    if (!res.ok) return fail(res);
    const direct = pick(res, 'settings');
    const safe = direct ? coerceSettings(direct.settings) : null;
    if (safe) store.update((s) => ({ ...s, settings: safe }));
    else await reloadSettings();
    toast.show(label, { tone: 'success' });
    return true;
  }

  async function writeOps(ops: ProfileOp[], label = 'Saved'): Promise<boolean> {
    if (ops.length === 0) return true;
    const res = await request({ type: 'profile-ops', ops });
    if (disposed) return false;
    if (!res.ok) return fail(res);
    const direct = pick(res, 'profile');
    const profile = direct ? coerceProfile(direct.profile) : null;
    if (profile) store.update((s) => ({ ...s, profile }));
    else await reloadProfile();
    toast.show(label, { tone: 'success' });
    return true;
  }

  const paired = (): boolean => store.get().settings?.paired === true;
  const privacy = (): PrivacySettings => store.get().profile?.settings.privacy.value ?? { storeSnippets: true, retentionDays: 90, learningEnabled: true, consentAt: null };

  const actions: OptionsActions = {
    navigate(route) {
      if (getHash().replace(/^#\/?/, '') !== route) setHash(`#${route}`);
      store.update((s) => ({ ...s, route, confirm: null }));
    },
    reload: load,
    setDraft(key, value) {
      drafts.set(key, value);
    },
    draft(key, fallback = '') {
      return drafts.get(key) ?? fallback;
    },
    clearError(key) {
      if (store.get().errors[key]) setError(key, null);
    },

    // ---- welcome -------------------------------------------------------
    async agree() {
      setBusy('agree', true);
      const ok = await writeOps([setOp('settings.privacy', { ...privacy(), consentAt: new Date().toISOString() })], 'Thanks. Jammarly can check text now.');
      setBusy('agree', false);
      if (ok) store.update((s) => ({ ...s, lastError: s.lastError }));
    },
    async saveApiKey(key) {
      const error = validateApiKey(key);
      setError('apiKey', error);
      if (error) return false;
      setBusy('apiKey', true);
      const res = await request({ type: 'set-settings', patch: { apiKey: key.trim() } });
      setBusy('apiKey', false);
      if (disposed) return false;
      if (!res.ok) return fail(res);
      const hint = keyHintFrom(res);
      // Clear the typed key before any re-render so it never lingers in the DOM.
      drafts.delete('apiKey');
      const direct = pick(res, 'settings');
      const safe = direct ? coerceSettings(direct.settings) : null;
      if (safe) store.update((s) => ({ ...s, settings: safe, keySavedHint: hint }));
      else {
        await reloadSettings();
        store.update((s) => ({ ...s, keySavedHint: hint }));
      }
      toast.show(hint ? `Key saved, ends with ${hint}` : 'Saved', { tone: 'success' });
      return true;
    },
    async testApiKey(key) {
      const error = validateApiKey(key);
      setError('apiKey', error);
      if (error) return;
      store.update((s) => ({ ...s, keyTest: { status: 'testing' } }));
      const res = await request({ type: 'test-api-key', apiKey: key.trim() }, { timeoutMs: 30_000 });
      if (disposed) return;
      const test = pick(res, 'api-key-test');
      if (!test) {
        store.update((s) => ({ ...s, keyTest: { status: 'done', valid: false, message: res.ok ? 'Unexpected answer from the extension.' : describeFailure(res) } }));
        return;
      }
      store.update((s) => ({ ...s, keyTest: { status: 'done', valid: test.valid === true, model: test.model, message: test.message } }));
    },
    async setMockProvider(on) {
      await writeSettings({ provider: on ? 'mock' : 'anthropic' }, on ? 'Using the mock engine' : 'Using the Anthropic engine');
    },
    async pair(pairingId, code) {
      const error = validatePairing(pairingId, code);
      setError('pair', error);
      if (error) return false;
      setBusy('pair', true);
      const res = await request({ type: 'pair', pairingId: pairingId.trim(), code: code.trim() }, { timeoutMs: 30_000 });
      setBusy('pair', false);
      if (disposed) return false;
      if (!res.ok) {
        setError('pair', describeFailure(res));
        return fail(res);
      }
      const paired = pick(res, 'paired');
      store.update((s) => ({ ...s, pairedDeviceId: paired?.deviceId ?? s.pairedDeviceId }));
      drafts.delete('pairingId');
      drafts.delete('pairCode');
      await Promise.all([reloadSettings(), reloadProfile(), reloadUsageAndSync()]);
      toast.show('Paired with the web app', { tone: 'success' });
      return true;
    },
    async chooseDefaultSites(choice) {
      store.update((s) => ({ ...s, defaultSites: choice }));
      if (choice === 'opt-in') {
        await writeOps([setOp('settings.checkOptedOutFields', false)], 'Saved. Turn sites on from the toolbar popup.');
      } else {
        toast.show('Jammarly will check text everywhere');
      }
    },
    finishWelcome() {
      actions.navigate('general');
    },

    // ---- general -------------------------------------------------------
    setDeviceSetting(patch, label) {
      return writeSettings(patch, label);
    },
    async saveBudget(raw) {
      const n = Number(raw.trim());
      if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
        setError('dailyBudgetUsd', 'Enter 0 or a positive amount.');
        return false;
      }
      setError('dailyBudgetUsd', null);
      drafts.delete('dailyBudgetUsd');
      return writeSettings({ dailyBudgetUsd: Math.round((n + Number.EPSILON) * 100) / 100 }, n === 0 ? 'Saved. No daily limit.' : 'Saved');
    },
    async setEngineSetting(key, value) {
      const v = value.trim();
      if (!v) {
        setError(key, 'Enter a model id.');
        return false;
      }
      setError(key, null);
      if (paired()) {
        const path: LwwPath = key === 'mode' ? 'settings.mode' : key === 'model' ? 'settings.model' : 'settings.fastModel';
        return writeOps([setOp(path, v)], 'Saved and synced across devices');
      }
      return writeSettings({ [key]: v } as Partial<DeviceSettings>);
    },

    // ---- suggestions ---------------------------------------------------
    setGoals(goals) {
      return writeOps([setOp('settings.goals', goals)]);
    },
    setDialect(dialect) {
      return writeOps([setOp('settings.dialect', dialect)]);
    },
    setCategories(categories) {
      return writeOps([setOp('settings.categories', categories)]);
    },
    async saveCustomInstructions(text) {
      if (text.length > CUSTOM_INSTRUCTIONS_MAX) {
        setError('customInstructions', `Keep it under ${CUSTOM_INSTRUCTIONS_MAX} characters.`);
        return false;
      }
      setError('customInstructions', null);
      const ok = await writeOps([setOp('settings.customInstructions', text)]);
      if (ok) drafts.delete('customInstructions');
      return ok;
    },
    unmuteRule(rule) {
      return writeOps([removeOp('rules.muted', rule)], 'Rule turned back on');
    },

    // ---- sites ---------------------------------------------------------
    async addDisabledSite(input) {
      const host = normalizeHost(input);
      if (!host) {
        setError('disabledSite', 'Enter a hostname like mail.google.com.');
        return false;
      }
      setError('disabledSite', null);
      const ok = await writeOps([addOp('sites.disabled', host)], `Jammarly is off on ${host}`);
      if (ok) drafts.delete('disabledSite');
      return ok;
    },
    removeDisabledSite(host) {
      return writeOps([removeOp('sites.disabled', host)], `Jammarly is back on for ${host}`);
    },
    async addIgnoreOptOutHost(input) {
      const host = normalizeHost(input);
      if (!host) {
        setError('ignoreOptOutHost', 'Enter a hostname like app.slack.com.');
        return false;
      }
      setError('ignoreOptOutHost', null);
      const current = store.get().profile?.settings.ignoreOptOutHosts.value ?? [];
      if (current.includes(host)) return true;
      const ok = await writeOps([setOp('settings.ignoreOptOutHosts', [...current, host].sort())]);
      if (ok) drafts.delete('ignoreOptOutHost');
      return ok;
    },
    removeIgnoreOptOutHost(host) {
      const current = store.get().profile?.settings.ignoreOptOutHosts.value ?? [];
      return writeOps([setOp('settings.ignoreOptOutHosts', current.filter((h) => h !== host))]);
    },
    setCheckOptedOutFields(on) {
      return writeOps([setOp('settings.checkOptedOutFields', on)]);
    },

    // ---- dictionary ----------------------------------------------------
    async addWord(word) {
      const w = word.trim();
      if (!w || /\s/.test(w)) {
        setError('word', 'Enter a single word.');
        return false;
      }
      setError('word', null);
      const ok = await writeOps([addOp('dictionary', w)], `Added "${w}"`);
      if (ok) drafts.delete('word');
      return ok;
    },
    removeWord(word) {
      return writeOps([removeOp('dictionary', word)], `Removed "${word}"`);
    },
    exportDictionary() {
      const words = liveValues(store.get().profile?.dictionary);
      const text = words.join('\n') + (words.length > 0 ? '\n' : '');
      download('jammarly-dictionary.txt', text);
      return text;
    },
    async importDictionary(text) {
      const existing = new Set(liveValues(store.get().profile?.dictionary));
      const words = parseWordList(text).filter((w) => !existing.has(w));
      if (words.length === 0) {
        toast.show('Nothing new to import');
        return 0;
      }
      const ok = await writeOps(
        words.map((w) => addOp('dictionary', w)),
        `Imported ${words.length} ${words.length === 1 ? 'word' : 'words'}`,
      );
      return ok ? words.length : 0;
    },

    // ---- sync ----------------------------------------------------------
    requestUnpair() {
      store.update((s) => ({ ...s, confirm: 'unpair' }));
    },
    async confirmUnpair() {
      store.update((s) => ({ ...s, confirm: null }));
      setBusy('unpair', true);
      const res = await request({ type: 'unpair' });
      setBusy('unpair', false);
      if (disposed) return;
      if (!res.ok) {
        fail(res);
        return;
      }
      store.update((s) => ({ ...s, pairedDeviceId: null }));
      await Promise.all([reloadSettings(), reloadUsageAndSync()]);
      toast.show('Unpaired. Settings stay on this device.', { tone: 'success' });
    },
    cancelConfirm() {
      store.update((s) => (s.confirm ? { ...s, confirm: null } : s));
    },
    async syncNow() {
      setBusy('sync', true);
      const res = await request({ type: 'sync-now' }, { timeoutMs: 30_000 });
      setBusy('sync', false);
      if (disposed) return;
      if (!res.ok) {
        fail(res);
        return;
      }
      await Promise.all([reloadProfile(), reloadUsageAndSync()]);
      toast.show('Synced', { tone: 'success' });
    },

    // ---- privacy -------------------------------------------------------
    setPrivacy(patch) {
      return writeOps([setOp('settings.privacy', { ...privacy(), ...patch })]);
    },
    requestWithdraw() {
      store.update((s) => ({ ...s, confirm: 'withdraw' }));
    },
    async confirmWithdraw() {
      store.update((s) => ({ ...s, confirm: null }));
      await writeOps([setOp('settings.privacy', { ...privacy(), consentAt: null })], 'Consent withdrawn. Checking stops until you agree again.');
    },
    async addPrivateSite(input) {
      const host = normalizeHost(input);
      if (!host) {
        setError('privateSite', 'Enter a hostname like mail.example.com.');
        return false;
      }
      setError('privateSite', null);
      const current = store.get().profile?.settings.privateSites.value ?? [];
      if (current.includes(host)) return true;
      const ok = await writeOps([setOp('settings.privateSites', [...current, host].sort())]);
      if (ok) drafts.delete('privateSite');
      return ok;
    },
    removePrivateSite(host) {
      const current = store.get().profile?.settings.privateSites.value ?? [];
      return writeOps([setOp('settings.privateSites', current.filter((h) => h !== host))]);
    },

    // ---- advanced ------------------------------------------------------
    async openSidePanel() {
      const res = await request({ type: 'open-side-panel' });
      if (disposed) return;
      if (!res.ok) fail(res);
      else toast.show('Side panel opened');
    },
    async openShortcutSettings() {
      const tabs = (globalThis as { chrome?: typeof chrome }).chrome?.tabs;
      try {
        if (!tabs) throw new Error('no tabs api');
        await tabs.create({ url: SHORTCUTS_URL });
      } catch {
        toast.show(`Open ${SHORTCUTS_URL} in a new tab to change the keys.`, { durationMs: 8000 });
      }
    },
  };

  const render = (): void => {
    if (disposed) return;
    preserveFocus(root, () => renderOptions(root, store.get(), actions, toast));
  };
  const unsubscribe = store.subscribe(render);
  const stopTheme = watchTheme(document.documentElement, () => ({ colorblind: store.get().settings?.colorblindMode === true }));
  const onHashChange = (): void => {
    store.update((s) => ({ ...s, route: routeFromHash(getHash(), s.profile), confirm: null }));
  };
  window.addEventListener('hashchange', onHashChange);
  // Coming back from Chrome's shortcuts page: show the keys just set.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void reloadShortcuts();
  };
  document.addEventListener('visibilitychange', onVisible);
  render();
  const ready = load();

  return {
    store,
    actions,
    toast,
    drafts,
    ready,
    dispose() {
      disposed = true;
      unsubscribe();
      stopTheme();
      window.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}

/** Downloads text as a file through a Blob URL (no-op where createObjectURL is unavailable). */
export function downloadText(filename: string, text: string): void {
  const urlApi = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void } }).URL;
  if (!urlApi?.createObjectURL || typeof Blob === 'undefined') return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = urlApi.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => urlApi.revokeObjectURL?.(url), 1000);
}

/** The extension's own id and version for the Advanced section. */
export function extensionInfo(): { id: string; version: string } {
  const api = chromeApi();
  let version = '';
  try {
    version = api?.runtime?.getManifest?.()?.version ?? '';
  } catch {
    version = '';
  }
  return { id: api?.runtime?.id ?? '', version };
}

/** The manifest's keyboard commands with their current keys (Chrome's own popup entry left out). */
export async function readShortcuts(): Promise<ShortcutInfo[] | null> {
  const commands = (globalThis as { chrome?: typeof chrome }).chrome?.commands;
  if (!commands?.getAll) return null;
  try {
    const all = await commands.getAll();
    return all
      .filter((c) => typeof c.name === 'string' && c.name !== '_execute_action')
      .map((c) => ({ name: c.name!, description: c.description ?? c.name!, shortcut: c.shortcut ?? '' }));
  } catch {
    return null;
  }
}
