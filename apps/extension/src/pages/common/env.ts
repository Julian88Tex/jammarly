/**
 * Build-time flags and runtime capability checks shared by the three extension pages (side panel, popup,
 * options). Kept tiny and side-effect free so it loads under jsdom without a `chrome` global.
 */

// esbuild `define`s this identifier (see scripts/build.mjs). Under vitest it is undefined, so every read goes
// through `typeof` first. Declared module-locally so it never clashes with another entry's declaration.
declare const __JAMMARLY_DEV__: boolean | undefined;

/** True in `--dev` / `--watch` builds: enables the mock-engine toggle on the welcome page. */
export function isDevBuild(): boolean {
  return typeof __JAMMARLY_DEV__ !== 'undefined' && __JAMMARLY_DEV__ === true;
}

/** The `chrome` namespace when the page runs inside the extension (or a test installed a mock). */
export function chromeApi(): typeof chrome | null {
  const g = globalThis as { chrome?: typeof chrome };
  return g.chrome && typeof g.chrome === 'object' ? g.chrome : null;
}

/** The extension id, or '' outside the extension. */
export function extensionId(): string {
  const id = chromeApi()?.runtime?.id;
  return typeof id === 'string' ? id : '';
}

/** The manifest version, or '' when unavailable. */
export function extensionVersion(): string {
  try {
    const m = chromeApi()?.runtime?.getManifest?.();
    return m && typeof m.version === 'string' ? m.version : '';
  } catch {
    return '';
  }
}

/** How long the worker gets to answer 'open-options' before the page opens the options tab itself. */
export const OPEN_OPTIONS_TIMEOUT_MS = 2000;

/** Opens the options page; falls back to a tab with the page URL when the API is missing (tests, detached pages). */
export async function openOptionsPage(hash?: string): Promise<void> {
  const api = chromeApi();
  if (!api?.runtime) return;
  try {
    if (hash) {
      // openOptionsPage() cannot carry a hash; the worker's 'open-options' request can, so prefer it and fall back.
      // A worker that never answers (placeholder, suspended) must not leave the click dead: race a short timeout.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), OPEN_OPTIONS_TIMEOUT_MS);
      });
      let sent: Promise<unknown>;
      try {
        sent = Promise.resolve(api.runtime.sendMessage({ type: 'open-options', hash }));
      } catch {
        sent = Promise.resolve(undefined);
      }
      const reply = await Promise.race([sent.catch(() => undefined), timeout]);
      if (timer) clearTimeout(timer);
      if (reply && typeof reply === 'object' && (reply as { ok?: unknown }).ok === true) return;
      if (api.tabs?.create) {
        await Promise.resolve(api.tabs.create({ url: api.runtime.getURL(`options/options.html#${hash}`) })).catch(() => undefined);
        return;
      }
    }
    await Promise.resolve(api.runtime.openOptionsPage()).catch(() => undefined);
  } catch {
    // Nothing sensible to do: the page stays where it is.
  }
}
