import type { NextConfig } from 'next';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // The shared package ships TypeScript sources; Next compiles them as part of this app.
  transpilePackages: ['@jammarly/shared'],
  // Monorepo: trace files from the repo root so the serverless bundle includes packages/shared.
  outputFileTracingRoot: path.join(here, '../../'),
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      '*.css': { loaders: ['@tailwindcss/turbopack'], as: '*.css' },
    },
  },
};

export default nextConfig;
