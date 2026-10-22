/**
 * Playwright entry (not part of the extension build): bundled by tests/e2e/adapters.spec.ts with esbuild and
 * injected into fixture pages so the adapters can be exercised in a real Chromium without the extension.
 */
import { classify, fieldLabel, findEditable, isSmallField } from '../detect';
import { hostContext, resolveProfile } from '../sites';
import { adapterFactories, createAdapter, createAdapterForKind } from './index';

export const jammarlyAdapters = { createAdapter, createAdapterForKind, adapterFactories, resolveProfile, hostContext, classify, findEditable, fieldLabel, isSmallField };

declare global {
  interface Window {
    __jammarlyAdapters?: typeof jammarlyAdapters;
  }
}

window.__jammarlyAdapters = jammarlyAdapters;
