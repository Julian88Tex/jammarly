/**
 * Word maps for the rules. A Map, never a plain object: text is full of words like "constructor" and "toString"
 * that would otherwise resolve to Object.prototype members.
 */
export function dict<T>(entries: Record<string, T>): ReadonlyMap<string, T> {
  return new Map(Object.entries(entries));
}
