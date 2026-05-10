import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts', 'src/program.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
});
