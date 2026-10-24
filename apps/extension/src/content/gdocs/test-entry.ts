/**
 * Playwright entry (not part of the extension build): bundled by tests/e2e/gdocs.spec.ts with esbuild and injected
 * into tests/fixtures/gdocs.html after the bootstrap (addInitScript) and the MAIN-world bridge, so the isolated-world
 * pieces (GoogleDocsAdapter over the real RPC, gdocsStatus, registerGdocsAdapter, announceGdocsStatus) can be
 * exercised against the fixture's mock of Docs' annotated-text API in a real Chromium without the extension.
 */
import {
  GoogleDocsAdapter,
  announceGdocsStatus,
  createGdocsAdapter,
  defaultGdocsRpc,
  findGdocsEditorElement,
  gdocsStatus,
  isGdocsDocumentPage,
  registerGdocsAdapter,
  waitForGdocsActivation,
} from './adapter';
import { buildLayoutIndex, collectTextRuns, mapRunsToText, rectsForRange } from './geometry';
import { EventRpcClient, RPC_REQUEST_EVENT, RPC_RESULT_EVENT, STATUS_EVENT, TEXT_EVENT, decodeStatus } from './protocol';
import { DOCS_SENTINEL, NBSP, gdocsDocumentId, normalizeDocsText, normalizeNbsp, planDocsEdit, toPastePayload } from './text';

export const jammarlyGdocs = {
  GoogleDocsAdapter,
  announceGdocsStatus,
  createGdocsAdapter,
  defaultGdocsRpc,
  findGdocsEditorElement,
  gdocsStatus,
  isGdocsDocumentPage,
  registerGdocsAdapter,
  waitForGdocsActivation,
  EventRpcClient,
  decodeStatus,
  events: { RPC_REQUEST_EVENT, RPC_RESULT_EVENT, STATUS_EVENT, TEXT_EVENT },
  DOCS_SENTINEL,
  NBSP,
  gdocsDocumentId,
  normalizeDocsText,
  normalizeNbsp,
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
