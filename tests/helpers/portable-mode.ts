/**
 * Portable-gates mode (`RENDER_TAG_PORTABLE=1`, injected by vitest `define`
 * because the browser context has no `process.env`).
 *
 * The baseline files, cross-browser reference, fuzz signature sets and a few
 * hardcoded pixel tolerances are ENVIRONMENT-PINNED: they were recorded on the
 * maintainer's machine and are only meaningful there (font rasterization
 * differs per OS/runner image, so scores and knife-edge wraps drift). CI runs
 * with this flag set and gates only the suites that self-compare inside the
 * current environment (parity vs the same browser's DOM, overflow, unit
 * logic). The environment-pinned contracts remain the local deep gate.
 *
 * See CLAUDE.md "CI vs local deep testing".
 */
declare const __RENDER_TAG_PORTABLE__: boolean | undefined;

export const PORTABLE_GATES_ONLY =
  typeof __RENDER_TAG_PORTABLE__ !== 'undefined' && __RENDER_TAG_PORTABLE__;
