import { defineConfig } from 'tsup';

// Bundle each entry into a single ESM file so hooks start fast (no TS at runtime).
export default defineConfig({
  entry: { cli: 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
});
