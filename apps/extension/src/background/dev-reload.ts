/**
 * Self-update for unpacked installs. Chrome serves an unpacked extension's files straight from its folder, so when a
 * newer build lands there (for example after `git pull` of the extension-build branch) build.json on disk changes
 * while the running code is still the old build. Once a minute the worker compares the two and calls
 * chrome.runtime.reload(); the update handler then re-injects the content script into open tabs.
 *
 * The id of the build that is actually running is kept in storage.session, which survives service-worker restarts
 * but is cleared by a reload, so a worker woken up after the files changed still knows it is running old code.
 * Store installs never run this (installType is not "development").
 */

export const ALARM_DEV_RELOAD = 'jammarly-dev-reload';
export const BUILD_FILE = 'build.json';
const SESSION_KEY = 'jammarlyRunningBuild';
/** A pull writes many files; the id must read the same twice this far apart before reloading. */
export const SETTLE_MS = 3_000;

type ChromeLike = {
  runtime?: { getURL(path: string): string; reload(): void };
  management?: { getSelf(): Promise<{ installType?: string }> | void };
  alarms?: { create(name: string, info: { periodInMinutes: number; delayInMinutes?: number }): Promise<void> | void };
  storage?: { session?: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> } };
};

export interface DevReloadDeps {
  chrome: ChromeLike | undefined;
  /** Reads a packaged file fresh from disk (no HTTP cache). */
  readFile?: (url: string) => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface DevReload {
  /** Resolves true when this is an unpacked install and the alarm is armed. */
  start(): Promise<boolean>;
  /** Handles the alarm; returns true when it reloaded the extension. */
  check(): Promise<boolean>;
}

/** "commit@builtAt" from a build.json body, or null when it is missing or malformed. */
export function buildIdOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { commit?: unknown; builtAt?: unknown };
    if (typeof parsed.commit !== 'string' || typeof parsed.builtAt !== 'string') return null;
    return `${parsed.commit}@${parsed.builtAt}`;
  } catch {
    return null;
  }
}

export function createDevReload(deps: DevReloadDeps): DevReload {
  const c = deps.chrome;
  const readFile = deps.readFile ?? (async (url: string) => (await fetch(url, { cache: 'no-store' })).text());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let running: string | null = null;
  let armed = false;

  const diskId = async (): Promise<string | null> => {
    if (!c?.runtime) return null;
    try {
      return buildIdOf(await readFile(c.runtime.getURL(BUILD_FILE)));
    } catch {
      return null;
    }
  };

  return {
    async start() {
      if (!c?.runtime || !c.management?.getSelf || !c.alarms || !c.storage?.session) return false;
      let installType: string | undefined;
      try {
        installType = (await c.management.getSelf())?.installType;
      } catch {
        return false;
      }
      if (installType !== 'development') return false;
      const stored = (await c.storage.session.get(SESSION_KEY))[SESSION_KEY];
      if (typeof stored === 'string' && stored.length > 0) {
        running = stored;
      } else {
        running = await diskId();
        if (!running) return false;
        await c.storage.session.set({ [SESSION_KEY]: running });
      }
      await c.alarms.create(ALARM_DEV_RELOAD, { periodInMinutes: 1, delayInMinutes: 1 });
      armed = true;
      return true;
    },
    async check() {
      if (!armed || !running || !c?.runtime) return false;
      const first = await diskId();
      if (!first || first === running) return false;
      await sleep(SETTLE_MS);
      const second = await diskId();
      if (second !== first) return false; // still being written; the next alarm tries again
      c.runtime.reload();
      return true;
    },
  };
}
