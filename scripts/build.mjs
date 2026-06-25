import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist/extension', { recursive: true });

await build({
  entryPoints: ['src/extension/background.js'],
  bundle: true,
  format: 'esm',
  outfile: 'dist/extension/background.js',
});

await build({
  entryPoints: ['src/extension/content.js'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/extension/content.js',
});

await build({
  entryPoints: ['src/extension/page-hook.js'],
  bundle: true,
  format: 'iife',
  outfile: 'dist/extension/page-hook.js',
});

await copyFile('src/extension/manifest.json', 'dist/extension/manifest.json');
