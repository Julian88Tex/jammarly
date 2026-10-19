// Build script: bundles each extension entry point with esbuild and copies static assets.
// Usage: node scripts/build.mjs [--watch] [--dev]
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev') || watch;

const entries = {
  'background/service-worker': 'src/background/service-worker.ts',
  'content/content-script': 'src/content/content-script.ts',
  'sidepanel/sidepanel': 'src/sidepanel/sidepanel.ts',
  'options/options': 'src/options/options.ts',
  'popup/popup': 'src/popup/popup.ts',
};

const existingEntries = Object.fromEntries(
  Object.entries(entries).filter(([, src]) => existsSync(path.join(root, src))),
);

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  format: 'iife', // content scripts and classic service workers cannot use ESM imports at runtime
  target: ['chrome120'],
  platform: 'browser',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
    'globalThis.__JAMMARLY_DEV__': JSON.stringify(dev),
  },
  
  outdir: dist,
  outbase: 'src',
  entryPoints: Object.values(existingEntries).map((p) => path.join(root, p)),
  entryNames: '[dir]/[name]',
  loader: { '.css': 'text', '.svg': 'text', '.html': 'text' },
};

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  if (existsSync(path.join(root, 'public'))) {
    await cp(path.join(root, 'public'), dist, { recursive: true });
  }
  // Stamp version from package.json into manifest.json so they never drift.
  const manifestPath = path.join(dist, 'manifest.json');
  if (existsSync(manifestPath)) {
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = pkg.version;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
}

async function main() {
  await rm(dist, { recursive: true, force: true });
  await copyStatic();
  if (watch) {
    const ctx = await esbuild.context(common);
    await ctx.watch();
    console.log('[build] watching for changes...');
  } else {
    const result = await esbuild.build({ ...common, metafile: true });
    const outputs = Object.entries(result.metafile.outputs)
      .filter(([f]) => f.endsWith('.js'))
      .map(([f, o]) => `${path.relative(root, f)}  ${(o.bytes / 1024).toFixed(1)} KB`);
    console.log('[build] outputs:\n  ' + outputs.join('\n  '));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
