/**
 * Discord (discord.com, canary/ptb subdomains). Slate editor (`[data-slate-editor="true"]`): execCommand is
 * ignored, synthetic beforeinput insertReplacementText with target ranges is the write path. Void nodes
 * (mentions, emoji) and zero-width spans are protected; the U+FEFF anchors are also in the serialized zero-width list.
 */
import { defineProfile, firstMatch, hostIs } from './base';

const CHANNEL_RE = /\/channels\/(?:@me|\d+)\/(\d+)/;

/** Pure: channel id from the URL, else "". */
export function discordDocHint(pathname: string): string {
  const id = firstMatch(pathname, [CHANNEL_RE]);
  return id ? `discord:${id}` : '';
}

export const discord = defineProfile({
  id: 'discord',
  matches: hostIs('discord.com', '*.discord.com'),
  context: 'chat',
  ladder: ['beforeinput', 'paste', 'splice'],
  protectedSelectors: ['[data-slate-void]', '[data-slate-zero-width]'],
  bodySelectors: ['[data-slate-editor="true"]'],
  docHint: (location) => discordDocHint(location.pathname),
});
