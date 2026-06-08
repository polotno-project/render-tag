import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Vitest browser custom command: write a wrap report from the browser to disk.
 * Registered in the vitest configs under `test.browser.commands`.
 */
export const saveWrapReport = async (
  _ctx: unknown,
  relPath: string,
  content: string,
): Promise<string> => {
  const abs = resolve(process.cwd(), relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
};
