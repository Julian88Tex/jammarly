/**
 * Run work after the response is sent (`after()` from next/server) when a request scope exists, inline
 * otherwise (tests, scripts). The learning job is bounded by the route's maxDuration either way.
 */
let mode: 'auto' | 'inline' = 'auto';

export function setBackgroundModeForTests(next: 'auto' | 'inline'): void {
  mode = next;
}

export async function scheduleBackground(task: () => Promise<void>): Promise<'after' | 'inline'> {
  if (mode === 'auto') {
    try {
      const { after } = await import('next/server');
      after(async () => {
        try {
          await task();
        } catch (err) {
          console.error('[jammarly] background task failed:', err instanceof Error ? err.message : String(err));
        }
      });
      return 'after';
    } catch {
      // No request scope: fall through and run inline.
    }
  }
  await task();
  return 'inline';
}
