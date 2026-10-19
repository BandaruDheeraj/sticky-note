import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    testTimeout: 20_000,
    env: { STICKY_NO_BACKGROUND_SYNC: '1' },
  },
});
