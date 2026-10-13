// Vendors the pinned test fonts into tests/fonts/ from the @fontsource packages
// named below: each CSS file the lanes import, with the woff2 subsets it
// references copied beside it (the woff fallbacks are dropped: every lane's
// engine takes woff2). The packages are taken from node_modules when the
// installed version matches, else installed into a temp prefix; nothing is
// added to package.json. tests/fonts/MANIFEST.json records the versions and
// a sha256 per file; the native-capture digest hashes that manifest.
// Run: npm run vendor:fonts
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '5.3.0';
/** package → vendored directory, CSS files to copy, bare woff2 files to copy. */
const SOURCES = [
  ['@fontsource-variable/open-sans', 'open-sans', ['wght.css', 'wght-italic.css']],
  ['@fontsource-variable/roboto', 'roboto', ['wght.css', 'wght-italic.css']],
  ['@fontsource-variable/playfair-display', 'playfair-display', ['wght.css', 'wght-italic.css']],
  ['@fontsource-variable/merriweather', 'merriweather', ['wght.css', 'wght-italic.css']],
  ['@fontsource-variable/inconsolata', 'inconsolata', ['wght.css']],
  ['@fontsource-variable/noto-sans-thai', 'noto-sans-thai', ['wght.css']],
  ['@fontsource-variable/noto-sans-myanmar', 'noto-sans-myanmar', ['wght.css']],
  ['@fontsource-variable/noto-sans-khmer', 'noto-sans-khmer', ['wght.css']],
  ['@fontsource-variable/noto-sans-devanagari', 'noto-sans-devanagari', ['wght.css']],
  ['@fontsource/lobster', 'lobster', ['400.css']],
  ['@fontsource/noto-emoji', 'noto-emoji', ['400.css']],
  ['@fontsource/noto-sans-arabic', 'noto-sans-arabic', ['400.css']],
  ['@fontsource/noto-sans-jp', 'noto-sans-jp', ['400.css']],
  ['@fontsource/noto-sans-kr', 'noto-sans-kr', ['400.css']],
  ['@fontsource/noto-sans-sc', 'noto-sans-sc', ['400.css']],
  ['@fontsource-variable/arimo', 'arimo', [], ['arimo-latin-wght-normal.woff2', 'arimo-latin-wght-italic.woff2']],
];

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'tests/fonts');
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

let temp;
function packageDir(name) {
  const local = path.join(ROOT, 'node_modules', name);
  if (existsSync(local) && JSON.parse(readFileSync(path.join(local, 'package.json'), 'utf8')).version === VERSION) {
    return local;
  }
  if (!temp) {
    temp = mkdtempSync(path.join(tmpdir(), 'render-tag-fonts-'));
    const specs = SOURCES.map(([pkg]) => `${pkg}@${VERSION}`);
    console.log(`installing ${specs.length} packages into ${temp}`);
    execFileSync('npm', ['install', '--prefix', temp, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', ...specs], { stdio: 'inherit' });
  }
  return path.join(temp, 'node_modules', name);
}

const manifest = { generator: 'scripts/vendor-fonts.mjs', packages: {}, sha256: {} };
const files = {};
for (const [pkg, dir, cssFiles, bareFiles = []] of SOURCES) {
  const source = packageDir(pkg);
  const target = path.join(OUT, dir);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const woff2 = new Set(bareFiles);
  for (const cssFile of cssFiles) {
    const css = readFileSync(path.join(source, cssFile), 'utf8')
      // `url(./files/x.woff2) format('woff2'[-variations])[, url(./files/x.woff) format('woff')]`
      // → the woff2 beside the css, same format token.
      .replace(/src:\s*url\(\.\/files\/([^)]+\.woff2)\)\s*format\('(woff2(?:-variations)?)'\)(?:,\s*url\([^)]+\.woff\)\s*format\('woff'\))?;/g,
        (_match, file, format) => (woff2.add(file), `src: url(./${file}) format('${format}');`));
    const leftover = css.match(/url\([^)]*files\/[^)]*\)/);
    if (leftover) throw new Error(`${pkg}/${cssFile}: unrewritten ${leftover[0]}`);
    files[`${dir}/${cssFile}`] = Buffer.from(css);
  }
  for (const file of woff2) files[`${dir}/${file}`] = readFileSync(path.join(source, 'files', file));
  manifest.packages[pkg] = { version: VERSION, dir, css: cssFiles, files: [...woff2].sort() };
}
for (const [relative, buffer] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
  writeFileSync(path.join(OUT, relative), buffer);
  manifest.sha256[relative] = sha256(buffer);
}
writeFileSync(path.join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
if (temp) rmSync(temp, { recursive: true, force: true });
const stale = readdirSync(OUT).filter((entry) => entry !== 'MANIFEST.json' && !SOURCES.some(([, dir]) => dir === entry));
if (stale.length) console.warn(`stale entries in tests/fonts: ${stale.join(', ')}`);
console.log(`${Object.keys(files).length} files vendored into tests/fonts`);
