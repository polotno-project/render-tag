import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  resolve: {
    alias: {
      rasterizehtml: 'rasterizehtml/dist/rasterizeHTML.allinone.js',
    },
  },
});
