/**
 * Keyboard commands (manifest `commands`): toggle Jammarly on the active tab's site and accept all grammar in the
 * active field. `open-panel` and `_execute_action` are handled by Chrome itself.
 */
import type { CoreWithActivity } from './core';
import type { Hub } from './ports';
import { isLive } from './shared-engine';
import { hostOfUrl } from './util';

export interface CommandDeps {
  core: CoreWithActivity;
  hub: Hub;
  chrome: typeof chrome | undefined;
}

export async function handleCommand(command: string, tab: chrome.tabs.Tab | undefined, deps: CommandDeps): Promise<void> {
  const { core, hub } = deps;
  await core.ready;
  let tabId = typeof tab?.id === 'number' ? tab.id : null;
  let host = hostOfUrl(tab?.url);
  if (tabId === null || host.length === 0) {
    const active = await hub.activeTabHost();
    tabId = tabId ?? active.tabId;
    host = host || active.host;
  }
  if (command === 'toggle-on-site') {
    if (host.length === 0) return;
    const live = isLive(core.profile().sites.disabled, host);
    await core.applyProfileOps([live ? { op: 'remove', path: 'sites.disabled', value: host, hlc: '' } : { op: 'add', path: 'sites.disabled', value: host, hlc: '' }]);
    if (live) await core.setHostSessionOff(host, false);
    hub.broadcastConfig(host);
    return;
  }
  if (command === 'accept-all') {
    if (tabId === null) return;
    const field = hub.activeField(tabId);
    if (!field) return;
    hub.sendPanelAction({ type: 'accept-all', fieldId: field.fieldId, scope: { group: 'grammar' } });
  }
}

export function registerCommands(deps: CommandDeps): void {
  deps.chrome?.commands?.onCommand.addListener((command, tab) => {
    void handleCommand(command, tab, deps).catch((err) => console.debug('[jammarly] command failed', err));
  });
}
