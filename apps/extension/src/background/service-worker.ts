/**
 * Jammarly service worker (MV3). Placeholder entry: the engine, settings store and message router land
 * in the implementation phase. Kept minimal so the extension loads and the e2e harness can talk to it.
 */
import type { BackgroundRequest, BackgroundResponse } from '@jammarly/shared/types';

chrome.runtime.onInstalled.addListener(() => {
  console.debug('[jammarly] service worker installed');
});

chrome.runtime.onMessage.addListener((message: BackgroundRequest | { type: 'ping' }, _sender, sendResponse) => {
  if (message.type === 'ping') {
    sendResponse({ type: 'ok' } satisfies BackgroundResponse);
    return false;
  }
  return false;
});
