/**
 * Google Docs bootstrap. Runs in the MAIN world at document_start on https://docs.google.com/document/*.
 * Announces Jammarly's extension id to Docs' annotated-canvas mode before Docs' own scripts initialize.
 * Never overwrites a flag another extension already set. This file must stay free of HTML-string sinks
 * (page CSP and Trusted Types apply in the MAIN world). The real bridge lands in the implementation phase.
 */
declare const __JAMMARLY_GDOCS_ANNOUNCE_ID__: string;

(() => {
  const w = window as unknown as { _docs_annotate_canvas_by_ext?: string; __jammarlyAnnouncedId?: string };
  if (typeof w._docs_annotate_canvas_by_ext === 'string' && w._docs_annotate_canvas_by_ext.length > 0) {
    w.__jammarlyAnnouncedId = w._docs_annotate_canvas_by_ext;
    return;
  }
  // The isolated-world content script knows chrome.runtime.id; the MAIN world does not, so the id is
  // derived from the script's own URL (chrome-extension://<id>/content/gdocs-bootstrap.js).
  const own = __JAMMARLY_GDOCS_ANNOUNCE_ID__ || idFromScriptUrl();
  if (own) {
    w._docs_annotate_canvas_by_ext = own;
    w.__jammarlyAnnouncedId = own;
  }
})();

function idFromScriptUrl(): string {
  const src = (document.currentScript as HTMLScriptElement | null)?.src ?? '';
  const m = /^chrome-extension:\/\/([a-p]{32})\//.exec(src);
  return m?.[1] ?? '';
}
