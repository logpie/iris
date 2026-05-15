import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const packageDir = dirname(fileURLToPath(import.meta.url));

function copySkillAssets(): void {
  const srcDir = join(packageDir, 'src', 'skills');
  const outDir = join(packageDir, 'dist', 'skills');
  if (!existsSync(srcDir)) return;
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    if (entry.endsWith('.md')) {
      copyFileSync(join(srcDir, entry), join(outDir, entry));
    }
  }
}

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  onSuccess: copySkillAssets,
});
