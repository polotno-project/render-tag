/**
 * Node entry (`"node"` export condition). Same API as the browser entry —
 * render-tag stays zero-dependency, so nothing works out of the box here:
 * inject a DOM parser via setDOMParser() (linkedom, jsdom, …) and pass a
 * measurement `ctx` to layout(); functions throw with guidance otherwise.
 */
export * from './index.js';
