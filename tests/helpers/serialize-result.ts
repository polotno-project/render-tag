/**
 * Canonical JSON of an object graph. Keys are sorted; a repeated object
 * becomes `{"$ref":n}` (n = its first-visit index), which both breaks the
 * decoration-declarer cycles and pins WHICH nodes share a style or entry —
 * identity that `sameDecorationBand` and declarer stamping depend on.
 * Getters (`paintBounds`) are read like any property.
 */
export function serializeResult(root: unknown): string {
  const seen = new Map<object, number>();
  const walk = (value: unknown): unknown => {
    if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : String(value);
    if (typeof value === 'function') return '[function]';
    if (value === null || typeof value !== 'object') return value;
    const ref = seen.get(value);
    if (ref !== undefined) return { $ref: ref };
    seen.set(value, seen.size);
    if (Array.isArray(value)) return value.map(walk);
    if (value instanceof Map || value instanceof Set) return { [value.constructor.name]: [...value].map(walk) };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = walk((value as Record<string, unknown>)[key]);
    return out;
  };
  return JSON.stringify(walk(root));
}
