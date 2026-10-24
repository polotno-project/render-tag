/**
 * Every generated test output (triage reports, progress logs, the local
 * cross-browser recording, vitest attachments) lives in one git-ignored
 * folder. The path is repo-relative: vitest's browser `commands.readFile` /
 * `writeFile` resolve it against the project root and create the folder.
 */
export const OUT_DIR = 'tests/.out';

export function reportPath(name: string): string {
  return `./${OUT_DIR}/${name}`;
}
