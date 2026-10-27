/** Bounded memoization of completed model requests. In-flight work is never cached. */
export class CompletionCache<T> {
  private readonly entries = new Map<string, { expires: number; value: T }>();

  constructor(
    private readonly capacity = 32,
    private readonly ttlMs = 5000,
  ) {}

  static key(
    model: string,
    prompt: string,
    temperature: number,
    maxTokens: number,
    stop: readonly string[],
  ): string {
    return JSON.stringify([model, prompt, temperature, maxTokens, stop]);
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, now = Date.now(), ttlMs = this.ttlMs): void {
    if (this.capacity <= 0 || ttlMs <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, { expires: now + ttlMs, value });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
