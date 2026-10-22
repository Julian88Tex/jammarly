/**
 * Jammarly content script entry (isolated world, every frame). Wires the field registry, the worker port and the
 * overlay UI (src/content/controller) with the real detection, site-profile, adapter and UI modules.
 */
import { adapterFactories, createAdapter } from './adapters';
import { startContentScript } from './controller';
import { classify, fieldLabel, findEditable } from './detect';
import { announceGdocsStatus, isGdocsDocumentPage, registerGdocsAdapter, waitForGdocsActivation } from './gdocs/adapter';
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
  // Google Docs (ARCHITECTURE §3.8): once the MAIN-world bridge reports its verdict, register the inline adapter when
  // the annotated-text API is active and announce the status to the registry, which then attaches the adapter; when
  // inactive the registry shows the "not supported inline" state and the side panel's paste flow stays the path.
  // Nothing runs on other hosts.
  if (isGdocsDocumentPage()) {
    void waitForGdocsActivation().then((status) => {
      if (status.active) registerGdocsAdapter(adapterFactories);
      announceGdocsStatus(status);
    });
  }
})();
