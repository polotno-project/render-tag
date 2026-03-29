import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname),
  base: '/render-tag/',
  resolve: {
    alias: {
      'render-tag': path.resolve(__dirname, '../src/index.ts'),
      'html-to-svg': path.resolve(__dirname, '../vendor/html-to-svg/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        benchmark: path.resolve(__dirname, 'benchmark.html'),
      },
    },
  },
  server: {
    port: 3001,
  },
});
