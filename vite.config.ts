import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      'html-to-svg': path.resolve(__dirname, 'html-to-svg/src/index.ts'),
    },
  },
});
