import { defineConfig, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import path from 'path';

// The benchmark page imports the test corpus and with it every vendored face
// under tests/fonts (11 MB of woff2). The deployed site takes the same pinned
// package files from jsdelivr instead; `npm run dev` still serves tests/fonts.
const FONTS = path.resolve(__dirname, '../tests/fonts');
function fontsFromCdn(): Plugin {
  const manifest = JSON.parse(readFileSync(path.join(FONTS, 'MANIFEST.json'), 'utf8')) as {
    packages: Record<string, { version: string; dir: string; css: string[] }>;
  };
  const byDir = new Map(Object.entries(manifest.packages).map(([pkg, entry]) => [entry.dir, { pkg, ...entry }]));
  return {
    name: 'render-tag:fonts-from-cdn',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      if (!id.startsWith(FONTS) || !id.endsWith('?url')) return;
      const [dir, file] = id.slice(FONTS.length + 1, -'?url'.length).split('/');
      const entry = byDir.get(dir);
      if (!entry) throw new Error(`${id}: not in tests/fonts/MANIFEST.json`);
      const inPackage = entry.css.includes(file) ? file : `files/${file}`;
      return `export default ${JSON.stringify(`https://cdn.jsdelivr.net/npm/${entry.pkg}@${entry.version}/${inPackage}`)};`;
    },
  };
}

export default defineConfig({
  plugins: [fontsFromCdn()],
  root: path.resolve(__dirname),
  base: '/render-tag/',
  resolve: {
    alias: {
      'render-tag/path': path.resolve(__dirname, '../src/path/index.ts'),
      'render-tag': path.resolve(__dirname, '../src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        benchmark: path.resolve(__dirname, 'benchmark.html'),
        path: path.resolve(__dirname, 'path.html'),
      },
    },
  },
  server: {
    port: 3001,
  },
});
