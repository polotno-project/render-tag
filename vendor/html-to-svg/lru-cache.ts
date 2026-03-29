/**
 * Simple generic LRU cache backed by a Map.
 * Map iteration order is insertion order, so we delete-and-re-insert on access
 * to keep the most-recently-used entry at the end.
 */
export class LRUCache<K, V> {
  private map = new Map<K, V>();
  private _maxEntries: number;

  constructor(maxEntries: number) {
    this._maxEntries = maxEntries;
  }

  get maxEntries(): number {
    return this._maxEntries;
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this._maxEntries) {
      // Evict oldest (first key in iteration order)
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  /** Set with a callback invoked on eviction (before the evicted entry is removed). */
  setWithEviction(key: K, value: V, onEvict: (key: K, value: V) => void): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this._maxEntries) {
      const oldest = this.map.keys().next().value!;
      const oldestValue = this.map.get(oldest)!;
      this.map.delete(oldest);
      onEvict(oldest, oldestValue);
    }
    this.map.set(key, value);
  }

  clear(): void {
    this.map.clear();
  }

  /** Iterate all entries (oldest first). */
  forEach(fn: (value: V, key: K) => void): void {
    this.map.forEach(fn);
  }

  resize(maxEntries: number): void {
    this._maxEntries = maxEntries;
    while (this.map.size > maxEntries) {
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
  }
}
