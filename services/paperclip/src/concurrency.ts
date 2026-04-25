// Sliding-window request counter for Paperclip-lite.
//
// Tracks request timestamps per user in a sliding window.
// Returns 429-eligible response when the window is saturated.
//
// This is a lightweight alternative to the main BudgetManager concurrency
// check — it tracks *request rate* rather than concurrent active reservations.
// Both are enforced; the BudgetManager check fires first.

export interface ConcurrencyEntry {
  timestamps: number[]; // ms since epoch, ascending
}

export class SlidingWindowCounter {
  private readonly _entries = new Map<string, ConcurrencyEntry>();
  private readonly _windowMs: number;
  private readonly _maxRequests: number;

  constructor(windowMs: number, maxRequests: number) {
    this._windowMs = windowMs;
    this._maxRequests = maxRequests;
  }

  /**
   * Try to record a request for `key` (typically a user ID).
   * Returns `{ allowed: true }` if under the limit or `{ allowed: false, retryAfterMs }`.
   */
  tryRecord(key: string): { allowed: boolean; retryAfterMs?: number } {
    const now = Date.now();
    const entry = this._entries.get(key) ?? { timestamps: [] };

    // Evict expired timestamps.
    const cutoff = now - this._windowMs;
    const fresh = entry.timestamps.filter((t) => t > cutoff);

    if (fresh.length >= this._maxRequests) {
      // Oldest timestamp in window determines when a slot opens.
      const oldest = fresh[0]!;
      const retryAfterMs = oldest + this._windowMs - now;
      return { allowed: false, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    fresh.push(now);
    this._entries.set(key, { timestamps: fresh });
    return { allowed: true };
  }

  /** Count of requests in the current window for a key. */
  count(key: string): number {
    const now = Date.now();
    const entry = this._entries.get(key);
    if (!entry) return 0;
    return entry.timestamps.filter((t) => t > now - this._windowMs).length;
  }
}
