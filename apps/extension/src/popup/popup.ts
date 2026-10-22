/**
 * Popup entry (bundled to dist/popup/popup.js). The implementation lives in src/pages/popup.
 */
import { mountPopup } from '../pages/popup/app';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) return;
  mountPopup(root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
