import { defineConfig } from 'tsup';

// Pacotes do monorepo (@sf/*) entram no bundle; dependências declaradas no package.json ficam externas.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@sf\//],
  external: ['pg-native'],
});
