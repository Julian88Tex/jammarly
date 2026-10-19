/**
 * Jammarly content script. Placeholder entry: field detection, adapters, overlay UI and the hover card
 * land in the implementation phase. For now it only marks the document and pings the service worker so the
 * e2e harness can verify injection and messaging.
 */
(() => {
  const root = document.documentElement;
  if (!root || root.hasAttribute('data-jammarly')) return;
  root.setAttribute('data-jammarly', 'loaded');
  chrome.runtime
    .sendMessage({ type: 'ping' })
    .then((reply: unknown) => {
      root.setAttribute('data-jammarly-sw', JSON.stringify(reply));
    })
    .catch(() => {
      root.setAttribute('data-jammarly-sw', 'error');
    });
})();
