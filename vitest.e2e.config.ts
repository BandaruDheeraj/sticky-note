import { defineConfig } from 'vitest/config';

// End-to-end: runs the built dist/cli.js as real processes. Use `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
