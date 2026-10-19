import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@shared': path.resolve(__dirname, 'src/shared') } },
  test: {
    include: ['tests/unit/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'jsdom',
    globals: false,
    restoreMocks: true,
    coverage: { provider: 'v8', include: ['src/**/*.ts'] },
  },
});
