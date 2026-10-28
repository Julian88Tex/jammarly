import { execFileSync } from 'node:child_process';
// Build script: bundles each extension entry point with esbuild and copies static assets.
// Usage: node scripts/build.mjs [--watch] [--dev]
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
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
  'content/gdocs-bootstrap': 'src/content/gdocs/bootstrap.ts', // MAIN world, document_start
  'content/gdocs-main': 'src/content/gdocs/main-bridge.ts', // MAIN world, document_idle
  'sidepanel/sidepanel': 'src/sidepanel/sidepanel.ts',
  'options/options': 'src/options/options.ts',
  'popup/popup': 'src/popup/popup.ts',
};

/**
 * Build-time configuration injected into the manifest and the bundles.
 * JAMMARLY_APP_ORIGIN: production origin of the companion web app (e.g. https://jammarly-web.vercel.app). When set,
 *   it is added to host_permissions, externally_connectable.matches and the extension-page CSP connect-src.
 * JAMMARLY_GDOCS_ANNOUNCE_ID: dev-only override of the id announced to Google Docs (never set in release builds).
 */
const APP_ORIGIN = (process.env.JAMMARLY_APP_ORIGIN ?? '').replace(/\/+$/, '');
if (APP_ORIGIN && !/^https:\/\/[a-z0-9.-]+$/i.test(APP_ORIGIN)) {
  throw new Error(`JAMMARLY_APP_ORIGIN must be an https origin without a path, got: ${APP_ORIGIN}`);
}
const GDOCS_ANNOUNCE_ID = process.env.JAMMARLY_GDOCS_ANNOUNCE_ID ?? '';
/** Jammarly's own id, pinned by the manifest `key`. */
const EXTENSION_ID = readFileSync(path.join(root, 'EXTENSION_ID'), 'utf8').trim();

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
    '__JAMMARLY_DEV__': JSON.stringify(dev),
    '__JAMMARLY_APP_ORIGIN__': JSON.stringify(APP_ORIGIN),
    '__JAMMARLY_GDOCS_ANNOUNCE_ID__': JSON.stringify(GDOCS_ANNOUNCE_ID),
    '__JAMMARLY_VERSION__': JSON.stringify(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version),
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
    if (APP_ORIGIN) {
      const pattern = `${APP_ORIGIN}/*`;
      manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), pattern])];
      manifest.externally_connectable = { matches: [pattern] };
      manifest.content_security_policy = {
        extension_pages: `script-src 'self'; object-src 'self'; connect-src https://api.anthropic.com ${APP_ORIGIN}`,
      };
    } else {
      // Without an app origin no web page may message the extension. Keep the key so Chrome does not default to
      // allowing every other extension, but name only Jammarly's own id: an empty list makes Chrome show a warning.
      manifest.externally_connectable = { ids: [EXTENSION_ID] };
    }
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    // build.json identifies this exact build. An unpacked install compares it with the copy on disk and reloads
    // itself when a newer build lands in its folder (see src/background/dev-reload.ts).
    let commit = process.env.GITHUB_SHA ?? '';
    if (!commit) {
      try {
        commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      } catch {
        commit = 'unknown';
      }
    }
    const build = { version: pkg.version, commit, builtAt: new Date().toISOString() };
    await writeFile(path.join(dist, 'build.json'), JSON.stringify(build, null, 2) + '\n');
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
