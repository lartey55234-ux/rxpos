/**
 * A fixed-window counter, kept in memory.
 *
 * One process serves the pilot, so a shared store would be premature. The point
 * is only to stop someone grinding passwords or mass-registering pharmacies.
 */

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Record one attempt against a key. Throws once the window is full. */
  hit(key: string, now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      throw new RateLimitError("Too many attempts. Wait a few minutes and try again.");
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.prune(cutoff);
  }

  /** Forget keys whose window has passed, so a long-lived process stays small. */
  private prune(cutoff: number): void {
    for (const [key, times] of this.hits) {
      const recent = times.filter((at) => at > cutoff);
      if (recent.length === 0) this.hits.delete(key);
      else this.hits.set(key, recent);
    }
  }
}
