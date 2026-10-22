/**
 * The port hub (ARCHITECTURE §3.1): one `chrome.runtime.Port` per content frame ('jammarly-content') and per side
 * panel ('jammarly-sidepanel'). Owns the field registry, routes checks to the engine, mirrors progress and results
 * to panels, forwards panel actions to the content port that owns the field, turns dismiss/dictionary/mute/toggle
 * messages into profile ops and re-broadcasts EffectiveConfig when settings, profile or learned state change.
 */
import type {
  CheckRequest,
  ContentToWorker,
  DismissReason,
  EffectiveConfig,
  FieldState,
  PanelAction,
  PanelToWorker,
  ProfileOp,
  Suggestion,
  WorkerToContent,
  WorkerToPanel,
  WritingGoals,
} from '@jammarly/shared/types';
import type { CoreWithActivity } from './core';
import type { EngineMessage } from './engine/orchestrator';
import { checkError } from './engine/provider';
import { hostDisabled } from './config';
import { encodeMute, LEARNER_CONSTANTS, orSetHas, PROMPT_VERSION } from './shared-engine';
import type { InflightRecord } from './storage';
import { hostOfUrl } from './util';

export const CONTENT_PORT = 'jammarly-content';
export const PANEL_PORT = 'jammarly-sidepanel';
export const PANEL_FIELD_PREFIX = 'panel:';
export const DICTIONARY_WORD_MAX = 64;

type Port = chrome.runtime.Port;

interface ContentPortState {
  port: Port;
  tabId: number;
  frameId: number;
  host: string;
  href: string;
  fields: Set<string>;
  hello: boolean;
}

interface PanelPortState {
  port: Port;
  windowId: number | undefined;
}

interface FieldEntry {
  state: FieldState;
  owner: ContentPortState;
  docKey: string;
}

export interface Hub {
  attach(): void;
  broadcastConfig(host?: string): void;
  /** Forwards a panel action to the content port owning the field; false when unknown or a panel field. */
  sendPanelAction(action: PanelAction): boolean;
  activeField(tabId: number): FieldState | undefined;
  fields(): FieldState[];
  contentPortCount(): number;
  /** Sends 'recheck' to every field on `host` (all fields when null). */
  recheckHost(host: string | null): void;
  /** Requests persisted before a worker restart: a cancelled result is sent when their field reattaches. */
  rememberStaleInflight(records: readonly InflightRecord[]): void;
  /** Resolves the host of the active tab (for panels and commands). */
  activeTabHost(windowId?: number): Promise<{ host: string; tabId: number | null }>;
  /** Applies a dismiss (content or panel) and returns whether muted rules changed. */
  handleDismiss(msg: { fieldId: string; suggestionId: string; fingerprint: string; rule: string; docKey: string; reason?: DismissReason }, host: string): Promise<boolean>;
}

export function normalizeDictionaryWord(word: string): string {
  return word.trim().toLowerCase().slice(0, DICTIONARY_WORD_MAX);
}

function senderTabId(port: Port): number {
  const id = port.sender?.tab?.id;
  return typeof id === 'number' ? id : -1;
}

function senderFrameId(port: Port): number {
  const id = port.sender?.frameId;
  return typeof id === 'number' ? id : 0;
}

export function createHub(core: CoreWithActivity, chromeApi: typeof chrome | undefined): Hub {
  const contentPorts = new Map<Port, ContentPortState>();
  const panelPorts = new Map<Port, PanelPortState>();
  const registry = new Map<string, FieldEntry>();
  /** Last suggestions sent per field (id -> suggestion), for apply-report fingerprints. */
  const lastSuggestions = new Map<string, Map<string, Suggestion>>();
  const staleInflight = new Map<string, InflightRecord[]>();

  const post = (port: Port, msg: WorkerToContent | WorkerToPanel): void => {
    try {
      port.postMessage(msg);
    } catch (err) {
      console.debug('[jammarly] postMessage failed', err);
    }
  };
  const toPanels = (msg: WorkerToPanel): void => {
    for (const p of panelPorts.keys()) post(p, msg);
  };

  const panelConfigFor = async (panel: PanelPortState): Promise<WorkerToPanel> => {
    const { host } = await hub.activeTabHost(panel.windowId);
    return { type: 'config', config: core.configFor(host || 'sidepanel'), settings: core.publicSettings(), sync: core.syncState() };
  };

  const updateActivity = (): void => core.setContentActive(contentPorts.size > 0);

  const queueOps = async (ops: ProfileOp[]): Promise<boolean> => {
    const result = await core.applyProfileOps(ops);
    return result.applied > 0;
  };

  const engineSend = (owner: ContentPortState | null, panel: Port | null) => (msg: EngineMessage): void => {
    if (msg.type === 'check-result') {
      const map = new Map<string, Suggestion>();
      for (const s of msg.result.suggestions) map.set(s.id, s);
      lastSuggestions.set(msg.result.fieldId, map);
    }
    if (owner) {
      post(owner.port, msg);
      toPanels(msg);
    } else if (panel) {
      post(panel, msg);
    }
  };

  const runCheck = async (request: CheckRequest, owner: ContentPortState | null, panel: Port | null): Promise<void> => {
    await core.ready;
    const host = owner ? owner.host : request.host || 'sidepanel';
    const entry = registry.get(request.fieldId);
    const docKey = entry?.docKey ?? (request.fieldId.startsWith(PANEL_FIELD_PREFIX) ? `${PANEL_FIELD_PREFIX}${request.fieldId}` : '');
    const settings = core.settings();
    const config = core.configFor(host);
    await core.engine.check(request, {
      host,
      docKey,
      settings,
      profile: core.profile(),
      learned: core.learned(),
      config,
      ...(owner ? { tabId: owner.tabId, frameId: owner.frameId } : {}),
      send: engineSend(owner, panel),
    });
  };

  /** Dismiss reasons become manual overrides in rules.muted (ARCHITECTURE §3.7); "Never" on a core correctness rule only stores the dismissal. */
  const mutedOpsForDismiss = (rule: string, host: string, reason: string | undefined): ProfileOp[] => {
    if (reason === 'not_this_site' && host.length > 0) return [{ op: 'add', path: 'rules.muted', value: encodeMute(rule, host), hlc: '' }];
    if (reason === 'never' && !LEARNER_CONSTANTS.CORE_CORRECTNESS.has(rule)) return [{ op: 'add', path: 'rules.muted', value: encodeMute(rule), hlc: '' }];
    return [];
  };

  const handleGoals = async (goals: WritingGoals, scope: 'host' | 'global', host: string | undefined): Promise<void> => {
    if (scope === 'global' || !host) {
      await queueOps([{ op: 'set', path: 'settings.goals', value: goals, hlc: '' }]);
      hub.recheckHost(null);
      return;
    }
    const existing = core.profile().sites.overrides[host]?.value ?? {};
    await queueOps([{ op: 'set', path: `sites.overrides.${host}`, value: { ...existing, goals }, hlc: '' }]);
    hub.recheckHost(host);
  };

  const onContentMessage = async (state: ContentPortState, msg: ContentToWorker): Promise<void> => {
    switch (msg.type) {
      case 'hello': {
        state.hello = true;
        if (msg.host) state.host = msg.host;
        state.href = msg.href;
        await core.ready;
        post(state.port, { type: 'config', config: core.configFor(state.host) });
        return;
      }
      case 'field-attached': {
        await core.ready;
        const fieldState: FieldState = {
          fieldId: msg.fieldId,
          tabId: state.tabId,
          frameId: state.frameId,
          host: state.host,
          fieldKind: msg.fieldKind,
          label: msg.label,
          version: 0,
          textPreview: '',
          wordCount: 0,
          suggestions: [],
          status: 'idle',
          checkedBy: 'rules',
          active: false,
          undoAvailable: 0,
          transactions: [],
        };
        registry.set(msg.fieldId, { state: fieldState, owner: state, docKey: msg.docKey });
        state.fields.add(msg.fieldId);
        toPanels({ type: 'field-state', state: fieldState });
        const stale = staleInflight.get(msg.fieldId);
        if (stale) {
          staleInflight.delete(msg.fieldId);
          for (const rec of stale) {
            post(state.port, { type: 'check-result', result: { fieldId: rec.fieldId, version: rec.version, pass: rec.pass, suggestions: [], fromCache: false, blocks: [], error: checkError('cancelled', true, 'Jammarly restarted; checking again.') } });
          }
        }
        return;
      }
      case 'field-detached': {
        registry.delete(msg.fieldId);
        state.fields.delete(msg.fieldId);
        lastSuggestions.delete(msg.fieldId);
        core.engine.cancel(msg.fieldId);
        toPanels({ type: 'field-removed', fieldId: msg.fieldId });
        return;
      }
      case 'field-state': {
        const entry = registry.get(msg.state.fieldId);
        const merged: FieldState = { ...(entry?.state ?? {}), ...msg.state, tabId: state.tabId, frameId: state.frameId } as FieldState;
        if (entry) entry.state = merged;
        else registry.set(msg.state.fieldId, { state: merged, owner: state, docKey: '' });
        state.fields.add(msg.state.fieldId);
        toPanels({ type: 'field-state', state: merged });
        return;
      }
      case 'check':
        // Not awaited: a model call must never block later messages (cancel, ping) on this port.
        void runCheck(msg.request, state, null).catch((err) => console.debug('[jammarly] check failed', err));
        return;
      case 'cancel':
        core.engine.cancel(msg.fieldId);
        return;
      case 'feedback': {
        await core.ready;
        const config = core.configFor(state.host);
        const last = lastSuggestions.get(msg.events[0]?.fieldId ?? '');
        const model = last ? [...last.values()][0]?.model : undefined;
        await core.learning.ingest(msg.events, { deviceId: core.deviceId(), promptVersion: PROMPT_VERSION, storeSnippets: config.storeSnippets, ...(model ? { model } : {}) });
        core.sync.notifyEventsBuffered();
        return;
      }
      case 'voice-samples': {
        await core.ready;
        await core.learning.addSamples(msg.samples, core.configFor(state.host).storeSnippets);
        return;
      }
      case 'dismiss': {
        await core.ready;
        const changed = await hub.handleDismiss(msg, state.host);
        if (changed) hub.broadcastConfig(state.host);
        return;
      }
      case 'add-to-dictionary': {
        await core.ready;
        const word = normalizeDictionaryWord(msg.word);
        if (word.length === 0) return;
        if (await queueOps([{ op: 'add', path: 'dictionary', value: word, hlc: '' }])) hub.broadcastConfig();
        return;
      }
      case 'mute-rule': {
        await core.ready;
        const value = msg.scope === 'host' ? encodeMute(msg.rule, state.host) : encodeMute(msg.rule);
        if (await queueOps([{ op: 'add', path: 'rules.muted', value, hlc: '' }])) hub.broadcastConfig(msg.scope === 'host' ? state.host : undefined);
        return;
      }
      case 'toggle-host': {
        await core.ready;
        const profile = core.profile();
        const live = orSetHas(profile.sites.disabled, state.host);
        const op: ProfileOp | null = msg.enabled ? (live ? { op: 'remove', path: 'sites.disabled', value: state.host, hlc: '' } : null) : live ? null : { op: 'add', path: 'sites.disabled', value: state.host, hlc: '' };
        if (op) await queueOps([op]);
        hub.broadcastConfig(state.host);
        return;
      }
      case 'apply-report': {
        await core.ready;
        const known = lastSuggestions.get(msg.report.fieldId);
        const fromState = registry.get(msg.report.fieldId)?.state.suggestions ?? [];
        const fingerprints: string[] = [];
        for (const id of msg.report.appliedIds) {
          const s = known?.get(id) ?? fromState.find((x) => x.id === id);
          if (s) fingerprints.push(s.fingerprint);
        }
        await core.markApplied(msg.report.fieldId, fingerprints);
        return;
      }
      case 'ping':
        core.keepalive.tick();
        post(state.port, { type: 'ping' });
        return;
      default:
        return;
    }
  };

  const onPanelMessage = async (panel: PanelPortState, msg: PanelToWorker): Promise<void> => {
    switch (msg.type) {
      case 'hello': {
        if (typeof msg.windowId === 'number') panel.windowId = msg.windowId;
        await core.ready;
        post(panel.port, await panelConfigFor(panel));
        const { tabId } = await hub.activeTabHost(panel.windowId);
        post(panel.port, { type: 'fields', fields: hub.fields().map((f) => ({ ...f, active: f.active && f.tabId === tabId })) });
        return;
      }
      case 'panel-action':
        hub.sendPanelAction(msg.action);
        return;
      case 'check':
        void runCheck(msg.request, null, panel.port).catch((err) => console.debug('[jammarly] scratch check failed', err));
        return;
      case 'cancel':
        core.engine.cancel(msg.fieldId);
        return;
      case 'set-goals': {
        await core.ready;
        const host = msg.host ?? (msg.scope === 'host' ? (await hub.activeTabHost(panel.windowId)).host : undefined);
        await handleGoals(msg.goals, msg.scope, host);
        return;
      }
      case 'set-categories':
        await core.ready;
        await queueOps([{ op: 'set', path: 'settings.categories', value: msg.categories, hlc: '' }]);
        return;
      case 'dismiss': {
        await core.ready;
        const host = registry.get(msg.fieldId)?.owner.host ?? (await hub.activeTabHost(panel.windowId)).host;
        const changed = await hub.handleDismiss(msg, host);
        if (changed) hub.broadcastConfig(host);
        return;
      }
      case 'add-to-dictionary': {
        await core.ready;
        const word = normalizeDictionaryWord(msg.word);
        if (word.length === 0) return;
        if (await queueOps([{ op: 'add', path: 'dictionary', value: word, hlc: '' }])) hub.broadcastConfig();
        return;
      }
      case 'mute-rule': {
        await core.ready;
        const host = msg.host ?? (await hub.activeTabHost(panel.windowId)).host;
        const value = msg.scope === 'host' && host ? encodeMute(msg.rule, host) : encodeMute(msg.rule);
        if (await queueOps([{ op: 'add', path: 'rules.muted', value, hlc: '' }])) hub.broadcastConfig(msg.scope === 'host' ? host : undefined);
        return;
      }
      default:
        return;
    }
  };

  const onConnect = (port: Port): void => {
    if (port.name === CONTENT_PORT) {
      const state: ContentPortState = {
        port,
        tabId: senderTabId(port),
        frameId: senderFrameId(port),
        host: hostOfUrl(port.sender?.url),
        href: port.sender?.url ?? '',
        fields: new Set(),
        hello: false,
      };
      contentPorts.set(port, state);
      updateActivity();
      // Messages on one port are handled strictly in order (field-attached before field-state, ...).
      let chain: Promise<void> = Promise.resolve();
      port.onMessage.addListener((raw: unknown) => {
        if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
        chain = chain.then(() => onContentMessage(state, raw as ContentToWorker)).catch((err) => console.debug('[jammarly] content message failed', err));
      });
      port.onDisconnect.addListener(() => {
        void chromeApi?.runtime?.lastError;
        contentPorts.delete(port);
        for (const fieldId of state.fields) {
          core.engine.cancel(fieldId);
          registry.delete(fieldId);
          lastSuggestions.delete(fieldId);
          toPanels({ type: 'field-removed', fieldId });
        }
        updateActivity();
      });
      return;
    }
    if (port.name === PANEL_PORT) {
      const state: PanelPortState = { port, windowId: undefined };
      panelPorts.set(port, state);
      let chain: Promise<void> = Promise.resolve();
      port.onMessage.addListener((raw: unknown) => {
        if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') return;
        chain = chain.then(() => onPanelMessage(state, raw as PanelToWorker)).catch((err) => console.debug('[jammarly] panel message failed', err));
      });
      port.onDisconnect.addListener(() => {
        void chromeApi?.runtime?.lastError;
        panelPorts.delete(port);
      });
    }
  };

  const hub: Hub = {
    attach() {
      chromeApi?.runtime?.onConnect.addListener(onConnect);
      core.onConfigChange(() => hub.broadcastConfig());
      chromeApi?.tabs?.onActivated?.addListener(() => {
        for (const panel of panelPorts.values()) {
          void panelConfigFor(panel).then((msg) => post(panel.port, msg));
        }
      });
    },
    broadcastConfig(host) {
      const byHost = new Map<string, EffectiveConfig>();
      for (const state of contentPorts.values()) {
        if (host !== undefined && state.host !== host) continue;
        let config = byHost.get(state.host);
        if (!config) {
          config = core.configFor(state.host);
          byHost.set(state.host, config);
        }
        post(state.port, { type: 'config', config });
      }
      for (const panel of panelPorts.values()) {
        void panelConfigFor(panel).then((msg) => post(panel.port, msg));
      }
    },
    sendPanelAction(action) {
      if (action.fieldId.startsWith(PANEL_FIELD_PREFIX)) return false;
      const entry = registry.get(action.fieldId);
      if (!entry) return false;
      post(entry.owner.port, { type: 'panel-action', action });
      return true;
    },
    activeField(tabId) {
      for (const entry of registry.values()) {
        if (entry.state.tabId === tabId && entry.state.active) return entry.state;
      }
      return undefined;
    },
    fields() {
      return [...registry.values()].map((e) => e.state);
    },
    contentPortCount() {
      return contentPorts.size;
    },
    recheckHost(host) {
      for (const entry of registry.values()) {
        if (host !== null && entry.owner.host !== host) continue;
        post(entry.owner.port, { type: 'panel-action', action: { type: 'recheck', fieldId: entry.state.fieldId } });
      }
    },
    rememberStaleInflight(records) {
      for (const rec of records) {
        const list = staleInflight.get(rec.fieldId) ?? [];
        list.push(rec);
        staleInflight.set(rec.fieldId, list);
      }
    },
    async activeTabHost(windowId) {
      try {
        const query: chrome.tabs.QueryInfo = windowId === undefined ? { active: true, lastFocusedWindow: true } : { active: true, windowId };
        const tabs = (await chromeApi?.tabs?.query(query)) ?? [];
        const tab = tabs[0];
        if (!tab) return { host: '', tabId: null };
        return { host: hostOfUrl(tab.url), tabId: typeof tab.id === 'number' ? tab.id : null };
      } catch {
        return { host: '', tabId: null };
      }
    },
    async handleDismiss(msg, host) {
      const docKey = msg.docKey || registry.get(msg.fieldId)?.docKey || '';
      if (docKey.length > 0 && msg.fingerprint.length > 0) {
        await core.addDismissal(docKey, { fingerprint: msg.fingerprint, rule: msg.rule, at: new Date(core.now()).toISOString() });
      }
      const ops = mutedOpsForDismiss(msg.rule, host, msg.reason);
      if (ops.length === 0) return false;
      return queueOps(ops);
    },
  };

  // Guard: a host that is disabled stays disabled across config broadcasts (pure helper import kept referenced).
  void hostDisabled;
  return hub;
}
