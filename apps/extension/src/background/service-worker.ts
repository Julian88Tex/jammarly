/**
 * Jammarly service worker (MV3). Placeholder entry: the engine, settings store and message router land
 * in the implementation phase. Kept minimal so the extension loads and the e2e harness can talk to it.
 */
import type { RuntimeRequest, RuntimeResponse } from '@jammarly/shared/types';

chrome.runtime.onInstalled.addListener(() => {
  console.debug('[jammarly] service worker installed');
});

chrome.runtime.onMessage.addListener((message: RuntimeRequest, _sender, sendResponse) => {
  if (message.type === 'ping') {
    sendResponse({ ok: true, type: 'ok' } satisfies RuntimeResponse);
    return false;
  }
  return false;
});
