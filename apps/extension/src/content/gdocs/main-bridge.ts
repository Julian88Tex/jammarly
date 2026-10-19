/**
 * Google Docs MAIN-world bridge. Placeholder entry: exposes whether Docs activated the annotated-text API for
 * the announced id, so the isolated-world adapter can decide between inline mode and the side-panel fallback.
 * The full bridge (text polling, selection, paste-apply) lands in the implementation phase.
 */
(() => {
  const w = window as unknown as {
    _docs_annotate_getAnnotatedText?: unknown;
    __jammarlyAnnouncedId?: string;
  };
  const probe = () => {
    const active = typeof w._docs_annotate_getAnnotatedText === 'function';
    document.documentElement.dispatchEvent(
      new CustomEvent('jammarly:gdocs-status', { detail: { active, announcedId: w.__jammarlyAnnouncedId ?? '' } }),
    );
    return active;
  };
  let tries = 0;
  const timer = setInterval(() => {
    if (probe() || ++tries > 40) clearInterval(timer);
  }, 500);
})();
