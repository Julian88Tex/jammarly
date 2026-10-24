/**
 * Side panel entry (bundled by scripts/build.mjs to dist/sidepanel/sidepanel.js). Everything lives in
 * src/pages/sidepanel; this file only mounts it on the #app root.
 */
import { mountSidePanel } from '../pages/sidepanel/app';

function boot(): void {
  const root = document.getElementById('app');
  if (!root) return;
  mountSidePanel(root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
