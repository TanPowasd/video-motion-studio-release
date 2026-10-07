// Byte accounting bounds retained keys/serialized data, not native Skia allocations.
export class GeometryCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  constructor(
    readonly budgetBytes = 8 * 1024 * 1024,
    readonly maxEntries = 128,
  ) {}
  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return;
    }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  put(key: string, value: T, payloadBytes: number) {
    const bytes = key.length * 2 + payloadBytes;
    if (bytes > this.budgetBytes || !this.maxEntries) return;
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    while (
      this.entries.size &&
      (this.bytes + bytes > this.budgetBytes || this.entries.size >= this.maxEntries)
    ) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
      this.evictions++;
    }
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
  report() {
    return {
      entries: this.entries.size,
      accountedBytes: this.bytes,
      budgetBytes: this.budgetBytes,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
