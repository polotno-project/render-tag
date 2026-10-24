import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'RenderTag',
      formats: ['umd'],
      fileName: () => 'render-tag.umd.js',
    },
    outDir: 'lib',
    emptyOutDir: false,
  },
});
