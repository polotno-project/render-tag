import { FONT_VARIANTS } from './helpers/test-cases.ts';
import { fontMatrixSuite } from './helpers/render-corpus.ts';

for (const font of FONT_VARIANTS) fontMatrixSuite(font.name);
