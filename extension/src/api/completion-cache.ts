import { COMPLETION_CACHE_MAX_ENTRIES } from "~/core/constants.ts";

export type CompletionCacheKey = {
  model: string;
  prompt: string;
  temperature: number;
  maxTokens: number;
  stop: readonly string[];
};

/** Bounded memoization of completed model requests. In-flight work is never cached. */
export class CompletionCache<T> {
  private readonly entries = new Map<string, { expires: number; value: T }>();

  constructor(private readonly capacity = COMPLETION_CACHE_MAX_ENTRIES) {}

  get(key: CompletionCacheKey, now = Date.now()): T | undefined {
    const serializedKey = this.serializeKey(key);
    const entry = this.entries.get(serializedKey);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.entries.delete(serializedKey);
      return undefined;
    }
    this.entries.delete(serializedKey);
    this.entries.set(serializedKey, entry);
    return entry.value;
  }

  set(key: CompletionCacheKey, value: T, now: number, ttlMs: number): void {
    if (this.capacity <= 0 || ttlMs <= 0) return;
    const serializedKey = this.serializeKey(key);
    this.entries.delete(serializedKey);
    this.entries.set(serializedKey, { expires: now + ttlMs, value });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private serializeKey({
    model,
    prompt,
    temperature,
    maxTokens,
    stop,
  }: CompletionCacheKey): string {
    return JSON.stringify([model, prompt, temperature, maxTokens, stop]);
  }
}
