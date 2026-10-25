/**
 * Block-level result cache (ARCHITECTURE §3.2): LRU keyed by `cacheKey|blockHash`, storing block-relative
 * CachedSuggestions with the pass that produced them. Persisted to chrome.storage.session (debounced 1 s) so a
 * worker restart does not re-bill paragraphs; cleared on extension update and when the prompt version changes.
 */
import type { BlockCacheEntry, SessionSchema, TypedArea } from '../storage';
import { LIMITS } from '../storage';
import { debounce } from '../util';

export interface BlockCache {
  get(cacheKey: string, blockHash: string): BlockCacheEntry | undefined;
  set(cacheKey: string, blockHash: string, entry: BlockCacheEntry): void;
  has(cacheKey: string, blockHash: string): boolean;
  delete(cacheKey: string, blockHash: string): void;
  clear(): void;
  readonly size: number;
  /** Loads persisted entries; drops them when the persisted prompt version differs. */
  load(): Promise<void>;
  /** Writes pending changes now (tests, suspend). */
  flush(): Promise<void>;
}

export function cacheEntryKey(cacheKey: string, blockHash: string): string {
  return `${cacheKey}|${blockHash}`;
}

export interface BlockCacheOptions {
  max?: number;
  persistDelayMs?: number;
  promptVersion: string;
  session?: TypedArea<SessionSchema>;
}

export function createBlockCache(opts: BlockCacheOptions): BlockCache {
  const max = opts.max ?? LIMITS.BLOCK_CACHE_MAX;
  const map = new Map<string, BlockCacheEntry>();
  let dirty = false;

  const persistNow = async (): Promise<void> => {
    if (!opts.session || !dirty) return;
    dirty = false;
    await opts.session.set('blockCache', { promptVersion: opts.promptVersion, entries: [...map.entries()] });
  };
  const persist = debounce(() => {
    void persistNow();
  }, opts.persistDelayMs ?? 1000);

  const touch = (): void => {
    dirty = true;
    persist.call();
  };

  return {
    get size() {
      return map.size;
    },
    get(cacheKey, blockHash) {
      const k = cacheEntryKey(cacheKey, blockHash);
      const v = map.get(k);
      if (v === undefined) return undefined;
      // LRU: re-insert as most recent.
      map.delete(k);
      map.set(k, v);
      return v;
    },
    has(cacheKey, blockHash) {
      return map.has(cacheEntryKey(cacheKey, blockHash));
    },
    set(cacheKey, blockHash, entry) {
      const k = cacheEntryKey(cacheKey, blockHash);
      map.delete(k);
      map.set(k, entry);
      while (map.size > max) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
      touch();
    },
    delete(cacheKey, blockHash) {
      if (map.delete(cacheEntryKey(cacheKey, blockHash))) touch();
    },
    clear() {
      map.clear();
      touch();
    },
    async load() {
      if (!opts.session) return;
      await opts.session.ready;
      const stored = opts.session.get('blockCache');
      if (!stored) return;
      if (stored.promptVersion !== opts.promptVersion) {
        map.clear();
        touch();
        return;
      }
      for (const [k, v] of stored.entries.slice(-max)) map.set(k, v);
    },
    async flush() {
      persist.cancel();
      await persistNow();
    },
  };
}
