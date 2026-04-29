// Budget tracking for Paperclip-lite.
//
// Three limits enforced:
//   1. Per-user concurrency — max concurrent active reservations (default 4).
//   2. Per-turn token budget — max tokens per single reservation (default 80k).
//   3. Per-day USD budget — max spend per user per rolling calendar day (default $25).
//
// Hot state lives in-process (fast Map lookups). Postgres is the crash-recovery
// persistence layer written to asynchronously via the caller.
//
// No GxP / approval-gate concepts — this is heartbeat + budget + concurrency only.

export interface BudgetConfig {
  /** Max concurrent active reservations per user. */
  maxConcurrentPerUser: number;
  /** Max tokens per single turn/reservation. */
  maxTokensPerTurn: number;
  /** Max USD spend per user per calendar day. */
  maxUsdPerDay: number;
}

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxConcurrentPerUser: 4,
  maxTokensPerTurn: 80_000,
  maxUsdPerDay: 25.0,
};

export interface Reservation {
  reservationId: string;
  userEntraId: string;
  sessionId: string;
  estTokens: number;
  estUsd: number;
  reservedAt: number; // Date.now() ms
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: "concurrency_limit" | "token_budget" | "usd_budget";
  retryAfterMs?: number;
}

/**
 * In-process budget state manager.
 *
 * Thread-safety: Node.js is single-threaded; no locking needed.
 * For multi-instance deployments, use Postgres-backed checks instead
 * (Phase E will add a distributed lock if needed).
 */
export class BudgetManager {
  private readonly _config: BudgetConfig;

  // Map<userEntraId, Map<reservationId, Reservation>>
  private readonly _active = new Map<string, Map<string, Reservation>>();

  // Per-user per-day USD accumulator.
  // Map<"userId:YYYY-MM-DD", number>
  private readonly _dailyUsd = new Map<string, number>();

  constructor(config: BudgetConfig = DEFAULT_BUDGET_CONFIG) {
    this._config = config;
  }

  /** Current number of active reservations for a user. */
  concurrencyCount(userEntraId: string): number {
    return this._active.get(userEntraId)?.size ?? 0;
  }

  /** Today's USD spend for a user (UTC date). */
  todayUsd(userEntraId: string): number {
    const key = this._dailyKey(userEntraId);
    return this._dailyUsd.get(key) ?? 0;
  }

  /**
   * Check whether a new reservation can be made without exceeding limits.
   */
  check(opts: {
    userEntraId: string;
    estTokens: number;
    estUsd: number;
  }): BudgetCheckResult {
    const { userEntraId, estTokens, estUsd } = opts;

    // 1. Concurrency limit.
    if (this.concurrencyCount(userEntraId) >= this._config.maxConcurrentPerUser) {
      return {
        allowed: false,
        reason: "concurrency_limit",
        // Suggest retrying in 30s (a typical turn duration).
        retryAfterMs: 30_000,
      };
    }

    // 2. Per-turn token budget.
    if (estTokens > this._config.maxTokensPerTurn) {
      return {
        allowed: false,
        reason: "token_budget",
      };
    }

    // 3. Per-day USD budget.
    const spent = this.todayUsd(userEntraId);
    if (spent + estUsd > this._config.maxUsdPerDay) {
      const resetMs = this._msUntilDayReset();
      return {
        allowed: false,
        reason: "usd_budget",
        retryAfterMs: resetMs,
      };
    }

    return { allowed: true };
  }

  /**
   * Record a new reservation.
   * Caller must have already called check() and confirmed allowed=true.
   */
  reserve(reservation: Reservation): void {
    let userMap = this._active.get(reservation.userEntraId);
    if (!userMap) {
      userMap = new Map();
      this._active.set(reservation.userEntraId, userMap);
    }
    userMap.set(reservation.reservationId, reservation);
  }

  /**
   * Release a reservation and accumulate actual USD usage.
   * Returns false if the reservation was not found.
   */
  release(reservationId: string, actualUsd: number): boolean {
    for (const [userId, userMap] of this._active) {
      if (userMap.has(reservationId)) {
        userMap.delete(reservationId);
        // Accumulate actual USD for the day.
        const key = this._dailyKey(userId);
        this._dailyUsd.set(key, (this._dailyUsd.get(key) ?? 0) + actualUsd);
        return true;
      }
    }
    return false;
  }

  /**
   * Expire reservations older than maxAgeMs (default 5 minutes).
   * Called periodically to clean up orphaned reservations from crashed sessions.
   */
  expireStale(maxAgeMs = 5 * 60_000): number {
    const now = Date.now();
    let expired = 0;
    for (const userMap of this._active.values()) {
      for (const [id, res] of userMap) {
        if (now - res.reservedAt > maxAgeMs) {
          userMap.delete(id);
          expired++;
        }
      }
    }
    return expired;
  }

  /** Total active reservations across all users. */
  totalActive(): number {
    let total = 0;
    for (const userMap of this._active.values()) {
      total += userMap.size;
    }
    return total;
  }

  /**
   * Replace the in-memory daily-USD ledger with the supplied snapshot.
   * Called once at startup from index.ts after PaperclipState reads
   * paperclip_state for today's totals. Idempotent: calling again
   * overwrites whatever was in the map.
   *
   * Phase G — closes the "sidecar restart resets daily cap" hole. See
   * services/paperclip/src/persistence.ts and deep-review #11.
   */
  rehydrateDailyUsd(snapshot: Map<string, number>): void {
    this._dailyUsd.clear();
    for (const [key, amount] of snapshot) {
      this._dailyUsd.set(key, amount);
    }
  }

  private _dailyKey(userId: string): string {
    const d = new Date();
    const ymd = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    return `${userId}:${ymd}`;
  }

  private _msUntilDayReset(): number {
    const now = new Date();
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    return tomorrow.getTime() - Date.now();
  }
}
