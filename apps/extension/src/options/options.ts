/**
 * Options page entry (bundled to dist/options/options.js). The implementation lives in src/pages/options.
 */
import { mountOptions } from '../pages/options/app';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) return;
  mountOptions(root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
