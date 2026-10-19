// Packages dist/ into jammarly-<version>.zip for upload to the Chrome Web Store or sideloading.
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(path.join(root, 'dist/manifest.json'))) {
  console.error('dist/ not found. Run `npm run build` first.');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, `jammarly-${version}.zip`);
execSync(`cd "${path.join(root, 'dist')}" && zip -qr "${out}" .`, { stdio: 'inherit' });
console.log(`wrote ${out}`);
