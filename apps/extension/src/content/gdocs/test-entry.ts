/**
 * Playwright entry (not part of the extension build): bundled by tests/e2e/gdocs.spec.ts with esbuild and injected
 * into tests/fixtures/gdocs.html after the bootstrap (addInitScript) and the MAIN-world bridge, so the adapter can be
 * exercised against the fixture's mock of Docs' annotated-text API in a real Chromium without the extension.
 */
import { GoogleDocsAdapter, createGdocsAdapter, findGdocsEditorElement, gdocsStatus, isGdocsDocumentPage, registerGdocsAdapter, waitForGdocsActivation } from './adapter';
import { buildLayoutIndex, collectTextRuns, mapRunsToText, rectsForRange } from './geometry';
import { EventRpcClient, RPC_REQUEST_EVENT, RPC_RESULT_EVENT, STATUS_EVENT, TEXT_EVENT } from './protocol';
import { normalizeDocsText, planDocsEdit, toPastePayload } from './text';

export const jammarlyGdocs = {
  GoogleDocsAdapter,
  createGdocsAdapter,
  findGdocsEditorElement,
  gdocsStatus,
  isGdocsDocumentPage,
  registerGdocsAdapter,
  waitForGdocsActivation,
  EventRpcClient,
  events: { RPC_REQUEST_EVENT, RPC_RESULT_EVENT, STATUS_EVENT, TEXT_EVENT },
  normalizeDocsText,
  planDocsEdit,
  toPastePayload,
  collectTextRuns,
  mapRunsToText,
  buildLayoutIndex,
  rectsForRange,
};

declare global {
  interface Window {
    __jammarlyGdocs?: typeof jammarlyGdocs;
  }
}

window.__jammarlyGdocs = jammarlyGdocs;
