import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'RenderTag',
      formats: ['umd'],
      fileName: () => 'render-tag.umd.js',
    },
    outDir: 'lib',
    emptyOutDir: false,
    sourcemap: true,
    minify: true,
  },
});
