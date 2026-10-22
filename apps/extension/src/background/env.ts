/**
 * Build-time configuration of the service worker, read defensively so the modules load under vitest
 * (where esbuild's `define` never ran) and in the real bundle alike.
 */

/** Production origin of the companion web app; '' when the build had no JAMMARLY_APP_ORIGIN (pairing unavailable). */
export function appOrigin(): string {
  try {
    return typeof __JAMMARLY_APP_ORIGIN__ === 'string' ? __JAMMARLY_APP_ORIGIN__.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

/** Extension version from the build, falling back to the manifest, then '0.0.0'. */
export function extVersion(): string {
  try {
    if (typeof __JAMMARLY_VERSION__ === 'string' && __JAMMARLY_VERSION__.length > 0) return __JAMMARLY_VERSION__;
  } catch {
    // not defined
  }
  try {
    const g = globalThis as { chrome?: { runtime?: { getManifest?: () => { version?: unknown } } } };
    const v = g.chrome?.runtime?.getManifest?.()?.version;
    if (typeof v === 'string') return v;
  } catch {
    // no runtime
  }
  return '0.0.0';
}

export function isDevBuild(): boolean {
  try {
    return typeof __JAMMARLY_DEV__ === 'boolean' && __JAMMARLY_DEV__;
  } catch {
    return false;
  }
}
