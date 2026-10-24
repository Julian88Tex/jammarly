/**
 * Build-time globals injected by esbuild `define` (see scripts/build.mjs). Under vitest they are undefined,
 * so every read goes through `typeof` first (see src/background/env.ts). `__JAMMARLY_GDOCS_ANNOUNCE_ID__` is
 * deliberately not declared here: src/content/gdocs/bootstrap.ts is a script file and declares it itself.
 */
declare const __JAMMARLY_DEV__: boolean;
declare const __JAMMARLY_APP_ORIGIN__: string;
declare const __JAMMARLY_VERSION__: string;
