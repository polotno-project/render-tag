import { rm } from 'node:fs/promises';
import { NATIVE_DOM_CACHE_ROOT } from './helpers/native-dom-command.ts';

await rm(NATIVE_DOM_CACHE_ROOT, { recursive: true, force: true });
console.log(`Removed ${NATIVE_DOM_CACHE_ROOT}`);
