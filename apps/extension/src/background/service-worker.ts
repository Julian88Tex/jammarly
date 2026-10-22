/**
 * Jammarly service worker (MV3) entry. Everything is wired synchronously here (see ./worker.ts):
 * storage -> clock -> config -> ports -> engine -> sync -> learning -> runtime handlers -> commands.
 * The runtime `ping` answered with { ok: true, type: 'ok' } is part of the e2e smoke contract.
 */
import { createWorker } from './worker';

const worker = createWorker({ chrome: typeof chrome !== 'undefined' ? chrome : undefined });

worker.ready.catch((err) => {
  console.debug('[jammarly] worker startup failed', err);
});

// Exposed for debugging from the service-worker console (chrome://extensions -> service worker).
(globalThis as { __jammarly?: unknown }).__jammarly = worker;
