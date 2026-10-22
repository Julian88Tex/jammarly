import { describe, expect, it, vi } from 'vitest';
import { ALARM_DEV_RELOAD, buildIdOf, createDevReload } from '../../src/background/dev-reload';

function fakeChrome(installType: string, session: Record<string, unknown> = {}) {
  const reload = vi.fn();
  const create = vi.fn();
  return {
    reload,
    create,
    session,
    chrome: {
      runtime: { getURL: (p: string) => `chrome-extension://id/${p}`, reload },
      management: { getSelf: async () => ({ installType }) },
      alarms: { create: async (name: string, info: unknown) => void create(name, info) },
      storage: {
        session: {
          get: async (key: string) => (key in session ? { [key]: session[key] } : {}),
          set: async (items: Record<string, unknown>) => void Object.assign(session, items),
        },
      },
    },
  };
}

const build = (commit: string, at = '2026-10-22T10:00:00.000Z') => JSON.stringify({ version: '0.1.5', commit, builtAt: at });

describe('dev reload', () => {
  it('parses build ids and rejects malformed files', () => {
    expect(buildIdOf(build('abc'))).toBe('abc@2026-10-22T10:00:00.000Z');
    expect(buildIdOf('{}')).toBeNull();
    expect(buildIdOf('not json')).toBeNull();
  });

  it('does nothing for store installs', async () => {
    const f = fakeChrome('normal');
    const dr = createDevReload({ chrome: f.chrome, readFile: async () => build('a'), sleep: async () => {} });
    expect(await dr.start()).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    expect(await dr.check()).toBe(false);
  });

  it('reloads when a newer build lands on disk and stays put while it is unchanged', async () => {
    const f = fakeChrome('development');
    let disk = build('a');
    const dr = createDevReload({ chrome: f.chrome, readFile: async () => disk, sleep: async () => {} });
    expect(await dr.start()).toBe(true);
    expect(f.create).toHaveBeenCalledWith(ALARM_DEV_RELOAD, expect.objectContaining({ periodInMinutes: 1 }));
    expect(await dr.check()).toBe(false);
    disk = build('b');
    expect(await dr.check()).toBe(true);
    expect(f.reload).toHaveBeenCalledTimes(1);
  });

  it('waits while the files are still being written', async () => {
    const f = fakeChrome('development');
    const reads = [build('a'), build('b'), build('c')];
    let i = 0;
    const dr = createDevReload({ chrome: f.chrome, readFile: async () => reads[Math.min(i++, reads.length - 1)]!, sleep: async () => {} });
    await dr.start();
    expect(await dr.check()).toBe(false);
    expect(f.reload).not.toHaveBeenCalled();
  });

  it('remembers the running build across service-worker restarts', async () => {
    const session: Record<string, unknown> = {};
    const first = fakeChrome('development', session);
    await createDevReload({ chrome: first.chrome, readFile: async () => build('a'), sleep: async () => {} }).start();
    // The worker sleeps, the folder is updated, and a new worker instance wakes up reading the new files.
    const second = fakeChrome('development', session);
    const dr = createDevReload({ chrome: second.chrome, readFile: async () => build('b'), sleep: async () => {} });
    await dr.start();
    expect(await dr.check()).toBe(true);
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores a missing or broken build.json', async () => {
    const f = fakeChrome('development');
    let disk = build('a');
    const dr = createDevReload({ chrome: f.chrome, readFile: async () => disk, sleep: async () => {} });
    await dr.start();
    disk = '{ half written';
    expect(await dr.check()).toBe(false);
    expect(f.reload).not.toHaveBeenCalled();
  });
});
