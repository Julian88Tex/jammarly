/**
 * A tiny observable state container. Updates notify subscribers synchronously (renders stay deterministic under
 * test); `batch` coalesces several updates into one notification.
 */

export interface Store<T> {
  get(): T;
  set(next: T): void;
  update(fn: (prev: T) => T): void;
  /** Runs `fn`, notifying once at the end even if it calls set/update several times. */
  batch(fn: () => void): void;
  subscribe(fn: (state: T) => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  let depth = 0;
  let dirty = false;
  const subscribers = new Set<(state: T) => void>();

  const notify = (): void => {
    if (depth > 0) {
      dirty = true;
      return;
    }
    dirty = false;
    for (const fn of Array.from(subscribers)) {
      try {
        fn(state);
      } catch (err) {
        console.debug('[jammarly] store subscriber failed', err);
      }
    }
  };

  return {
    get: () => state,
    set(next) {
      if (next === state) return;
      state = next;
      notify();
    },
    update(fn) {
      const next = fn(state);
      if (next === state) return;
      state = next;
      notify();
    },
    batch(fn) {
      depth += 1;
      try {
        fn();
      } finally {
        depth -= 1;
      }
      if (depth === 0 && dirty) notify();
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}
