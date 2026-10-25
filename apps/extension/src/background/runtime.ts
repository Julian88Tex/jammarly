/**
 * `chrome.runtime.onMessage` (RuntimeRequest from options, popup, side panel and content click handlers) and
 * `chrome.runtime.onMessageExternal` (the web app's pairing message, accepted only from the compiled origin).
 * Every handler answers asynchronously except `open-side-panel`, which must call sidePanel.open() inside the user
 * gesture and therefore never awaits storage first.
 */
import { z } from 'zod';
import type { DeviceSettings, RuntimeRequest, RuntimeResponse } from '@jammarly/shared/types';
import type { ExternalPairMessage, ExternalPairReply } from '@jammarly/shared/api';
import type { ProfileOp } from '@jammarly/shared/profile';
import type { CoreWithActivity } from './core';
import type { Hub } from './ports';
import { orSetHas } from './shared-engine';
import { SyncHttpError } from './sync/client';
import { isRecord } from './util';

export const SettingsPatchSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(['anthropic', 'mock']),
    mode: z.enum(['hybrid', 'quality', 'economy']),
    model: z.string().trim().min(1).max(100),
    fastModel: z.string().trim().min(1).max(100),
    apiKey: z.string().max(400).transform((s) => s.trim()),
    debounceMs: z.number().int().min(100).max(10_000),
    showFloatingButton: z.boolean(),
    showUnderlines: z.boolean(),
    colorblindMode: z.boolean(),
    gdocsInline: z.enum(['auto', 'off']),
    dailyBudgetUsd: z.number().min(0).max(10_000),
    styleOwner: z.string().max(80).transform((s) => s.trim()),
  })
  .partial()
  .strict();

const ProfileOpSchema = z.union([
  z.object({ op: z.literal('set'), path: z.string().min(1).max(200), value: z.unknown(), hlc: z.string() }),
  z.object({ op: z.literal('add'), path: z.enum(['dictionary', 'rules.muted', 'sites.disabled']), value: z.string().min(1).max(200), hlc: z.string() }),
  z.object({ op: z.literal('remove'), path: z.enum(['dictionary', 'rules.muted', 'sites.disabled']), value: z.string().min(1).max(200), hlc: z.string() }),
  z.object({ op: z.literal('voice'), context: z.enum(['messages', 'documents']), profile: z.record(z.string(), z.unknown()), hlc: z.string() }),
  z.object({ op: z.literal('learning'), patch: z.record(z.string(), z.unknown()), hlc: z.string() }),
]);

export function validateSettingsPatch(patch: unknown): { ok: true; patch: Partial<DeviceSettings> } | { ok: false; message: string } {
  const r = SettingsPatchSchema.safeParse(patch);
  if (!r.success) return { ok: false, message: r.error.issues.map((i) => `${i.path.join('.') || 'patch'}: ${i.message}`).join('; ') };
  return { ok: true, patch: r.data as Partial<DeviceSettings> };
}

export function validateOps(ops: unknown): { ok: true; ops: ProfileOp[] } | { ok: false; message: string } {
  if (!Array.isArray(ops)) return { ok: false, message: 'ops must be an array' };
  const out: ProfileOp[] = [];
  for (const [i, op] of ops.entries()) {
    const r = ProfileOpSchema.safeParse(op);
    if (!r.success) return { ok: false, message: `ops[${i}]: ${r.error.issues.map((x) => x.message).join('; ')}` };
    out.push(r.data as ProfileOp);
  }
  return { ok: true, ops: out };
}

const fail = (code: string, message: string): RuntimeResponse => ({ ok: false, error: { code, message } });

export interface RuntimeDeps {
  core: CoreWithActivity;
  hub: Hub;
  chrome: typeof chrome | undefined;
}

/** Handles one RuntimeRequest. Exported for direct unit tests; `registerRuntimeHandlers` wires it to chrome. */
export async function handleRuntimeRequest(req: RuntimeRequest, sender: chrome.runtime.MessageSender | undefined, deps: RuntimeDeps): Promise<RuntimeResponse> {
  const { core, hub } = deps;
  switch (req.type) {
    case 'ping':
      return { ok: true, type: 'ok' };
    case 'get-settings':
      await core.ready;
      return { ok: true, type: 'settings', settings: core.publicSettings() };
    case 'set-settings': {
      await core.ready;
      const v = validateSettingsPatch(req.patch);
      if (!v.ok) return fail('invalid-settings', v.message);
      await core.saveSettings(v.patch);
      hub.broadcastConfig();
      return { ok: true, type: 'settings', settings: core.publicSettings() };
    }
    case 'get-profile':
      await core.ready;
      return { ok: true, type: 'profile', profile: core.profile() };
    case 'profile-ops': {
      await core.ready;
      const v = validateOps(req.ops);
      if (!v.ok) return fail('invalid-ops', v.message);
      const result = await core.applyProfileOps(v.ops);
      if (result.applied > 0) hub.broadcastConfig();
      if (result.rejected.length > 0) {
        return fail('op_rejected', `${result.rejected.length} of ${v.ops.length} ops rejected: ${result.rejected.map((r) => `${r.op.op} ${'path' in r.op ? r.op.path : r.op.op} (${r.reason})`).join(', ')}`);
      }
      return { ok: true, type: 'profile', profile: result.doc };
    }
    case 'test-api-key': {
      await core.ready;
      const settings = core.settings();
      const provider = core.providerFor({ ...settings, provider: settings.provider === 'mock' ? 'mock' : 'anthropic', apiKey: req.apiKey });
      if (!provider.testKey) return { ok: true, type: 'api-key-test', valid: false, message: 'Key test unavailable.' };
      const r = await provider.testKey(req.apiKey);
      return { ok: true, type: 'api-key-test', valid: r.valid, ...(r.model !== undefined ? { model: r.model } : {}), ...(r.message !== undefined ? { message: r.message } : {}) };
    }
    case 'pair': {
      await core.ready;
      if (!core.sync.available()) return fail('not-available', 'Pairing is not available in this build.');
      try {
        const r = await core.sync.redeem(req.pairingId, req.code);
        hub.broadcastConfig();
        return { ok: true, type: 'paired', deviceId: r.deviceId, appOrigin: r.appOrigin };
      } catch (err) {
        if (err instanceof SyncHttpError) return fail(err.code, err.message);
        return fail('network', err instanceof Error ? err.message : 'Pairing failed');
      }
    }
    case 'unpair':
      await core.ready;
      await core.sync.unpair();
      hub.broadcastConfig();
      return { ok: true, type: 'ok' };
    case 'sync-now':
      await core.ready;
      await core.sync.syncNow();
      return { ok: true, type: 'sync-state', sync: core.syncState() };
    case 'learn-voice-now':
      return fail('not-available', 'Runs in the web app in v1');
    case 'get-learning-summary':
      await core.ready;
      return { ok: true, type: 'learning-summary', summary: core.learning.summary() };
    case 'get-usage':
      await core.ready;
      return { ok: true, type: 'usage', usage: core.usageTotals() };
    case 'get-host-status':
      await core.ready;
      return { ok: true, type: 'host-status', host: req.host, enabled: core.configFor(req.host).enabledOnHost };
    case 'set-host-enabled': {
      await core.ready;
      const live = orSetHas(core.profile().sites.disabled, req.host);
      if (req.enabled && live) await core.applyProfileOps([{ op: 'remove', path: 'sites.disabled', value: req.host, hlc: '' }]);
      else if (!req.enabled && !live) await core.applyProfileOps([{ op: 'add', path: 'sites.disabled', value: req.host, hlc: '' }]);
      if (req.enabled) await core.setHostSessionOff(req.host, false);
      hub.broadcastConfig(req.host);
      return { ok: true, type: 'host-status', host: req.host, enabled: core.configFor(req.host).enabledOnHost };
    }
    case 'open-side-panel': {
      // Must run inside the user gesture: no storage await before sidePanel.open().
      const sp = deps.chrome?.sidePanel;
      if (!sp) return fail('not-available', 'Side panel API unavailable');
      const tabId = sender?.tab?.id;
      try {
        if (typeof tabId === 'number') {
          await sp.open({ tabId });
        } else {
          const tabs = (await deps.chrome?.tabs?.query({ active: true, lastFocusedWindow: true })) ?? [];
          const active = tabs[0];
          if (active && typeof active.id === 'number') await sp.open({ tabId: active.id });
          else if (active && typeof active.windowId === 'number') await sp.open({ windowId: active.windowId });
          else return fail('not-available', 'No active tab');
        }
        return { ok: true, type: 'ok' };
      } catch (err) {
        return fail('not-available', err instanceof Error ? err.message : 'Could not open the side panel');
      }
    }
    case 'open-options': {
      const c = deps.chrome;
      if (!c?.runtime) return fail('not-available', 'runtime unavailable');
      try {
        if (req.hash && c.tabs?.create) {
          await c.tabs.create({ url: c.runtime.getURL(`options/options.html#${req.hash.replace(/^#/, '')}`) });
        } else {
          await c.runtime.openOptionsPage();
        }
        return { ok: true, type: 'ok' };
      } catch (err) {
        return fail('not-available', err instanceof Error ? err.message : 'Could not open options');
      }
    }
    case 'get-sync-state':
      await core.ready;
      return { ok: true, type: 'sync-state', sync: core.syncState() };
    default:
      return fail('unknown-request', `Unknown request type ${(req as { type?: string }).type ?? ''}`);
  }
}

export function isExternalPairMessage(msg: unknown): msg is ExternalPairMessage {
  return isRecord(msg) && msg.type === 'jammarly.pair' && typeof msg.pairingId === 'string' && typeof msg.code === 'string';
}

/** The pairing message from the web app: accepted only when sender.origin equals the compiled origin. */
export async function handleExternalMessage(msg: unknown, sender: { origin?: string; url?: string } | undefined, deps: RuntimeDeps): Promise<ExternalPairReply> {
  const { core } = deps;
  const origin = core.appOrigin;
  if (origin.length === 0) return { ok: false, error: 'pairing_unavailable' };
  if (!sender || sender.origin !== origin) return { ok: false, error: 'origin_rejected' };
  if (!isExternalPairMessage(msg)) return { ok: false, error: 'bad_message' };
  await core.ready;
  try {
    const r = await core.sync.redeem(msg.pairingId, msg.code);
    deps.hub.broadcastConfig();
    return { ok: true, deviceId: r.deviceId };
  } catch (err) {
    return { ok: false, error: err instanceof SyncHttpError ? err.code : 'network' };
  }
}

export function registerRuntimeHandlers(deps: RuntimeDeps): void {
  const c = deps.chrome;
  if (!c?.runtime) return;
  c.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRecord(message) || typeof message.type !== 'string') return false;
    void handleRuntimeRequest(message as RuntimeRequest, sender, deps)
      .catch((err): RuntimeResponse => fail('internal', err instanceof Error ? err.message : 'internal error'))
      .then((response) => {
        try {
          sendResponse(response);
        } catch {
          // the sender went away
        }
      });
    return true;
  });
  c.runtime.onMessageExternal?.addListener((message: unknown, sender, sendResponse) => {
    void handleExternalMessage(message, sender, deps).then((reply) => {
      try {
        sendResponse(reply);
      } catch {
        // the page went away
      }
    });
    return true;
  });
}
