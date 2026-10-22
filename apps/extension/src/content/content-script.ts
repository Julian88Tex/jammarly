/**
 * Jammarly content script entry (isolated world, every frame). Wires the field registry, the worker port and the
 * overlay UI (src/content/controller) with the real detection, site-profile, adapter and UI modules.
 */
import { adapterFactories, createAdapter } from './adapters';
import { startContentScript } from './controller';
import { classify, fieldLabel, findEditable } from './detect';
import { resolveProfile } from './sites';
import { createOverlay } from './ui';

(() => {
  const root = document.documentElement;
  if (!root) return;
  // Injection markers for the e2e smoke test. <html> is skipped by the field opt-out walk, so `data-jammarly` here
  // never opts a field out.
  if (!root.hasAttribute('data-jammarly')) {
    root.setAttribute('data-jammarly', 'loaded');
    try {
      Promise.resolve(chrome.runtime.sendMessage({ type: 'ping' }))
        .then((reply: unknown) => root.setAttribute('data-jammarly-sw', JSON.stringify(reply)))
        .catch(() => root.setAttribute('data-jammarly-sw', 'error'));
    } catch {
      root.setAttribute('data-jammarly-sw', 'error');
    }
  }
  startContentScript({
    findEditable,
    classify,
    fieldLabel,
    resolveProfile,
    createAdapter,
    createOverlay,
    gdocsAdapter: () => adapterFactories.gdocs,
  });
})();
