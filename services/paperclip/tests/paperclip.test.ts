// Vitest tests for Paperclip-lite sidecar.
// 8+ tests covering budget, heartbeat, concurrency, and HTTP routes.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BudgetManager, DEFAULT_BUDGET_CONFIG } from "../src/budget.js";
import { HeartbeatTracker } from "../src/heartbeat.js";
import { SlidingWindowCounter } from "../src/concurrency.js";
import { MetricsCollector } from "../src/metrics.js";

// ---------------------------------------------------------------------------
// BudgetManager tests
// ---------------------------------------------------------------------------

describe("BudgetManager", () => {
  let mgr: BudgetManager;

  beforeEach(() => {
    mgr = new BudgetManager({
      maxConcurrentPerUser: 2,
      maxTokensPerTurn: 10_000,
      maxUsdPerDay: 5.0,
    });
  });

  it("allows a reservation within limits", () => {
    const result = mgr.check({
      userEntraId: "user-a",
      estTokens: 1_000,
      estUsd: 0.01,
    });
    expect(result.allowed).toBe(true);
  });

  it("rejects when concurrency limit reached", () => {
    // Reserve 2 slots (limit is 2).
    for (let i = 0; i < 2; i++) {
      mgr.reserve({
        reservationId: `res-${i}`,
        userEntraId: "user-b",
        sessionId: "sess-1",
        estTokens: 100,
        estUsd: 0.01,
        reservedAt: Date.now(),
      });
    }

    const result = mgr.check({ userEntraId: "user-b", estTokens: 100, estUsd: 0.01 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("concurrency_limit");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("rejects when token budget exceeded", () => {
    const result = mgr.check({
      userEntraId: "user-c",
      estTokens: 50_000,  // > 10_000 limit
      estUsd: 0.01,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("token_budget");
  });

  it("rejects when daily USD budget exceeded", () => {
    // Exhaust the day's USD budget via releases.
    mgr.reserve({ reservationId: "r1", userEntraId: "user-d", sessionId: "s1", estTokens: 100, estUsd: 4.99, reservedAt: Date.now() });
    mgr.release("r1", 4.99);

    const result = mgr.check({ userEntraId: "user-d", estTokens: 100, estUsd: 0.10 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("usd_budget");
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("releases a reservation and decrements concurrency", () => {
    mgr.reserve({ reservationId: "r-release", userEntraId: "user-e", sessionId: "s1", estTokens: 100, estUsd: 0.01, reservedAt: Date.now() });
    expect(mgr.concurrencyCount("user-e")).toBe(1);
    const found = mgr.release("r-release", 0.01);
    expect(found).toBe(true);
    expect(mgr.concurrencyCount("user-e")).toBe(0);
  });

  it("returns false when releasing unknown reservation", () => {
    const found = mgr.release("nonexistent-uuid", 0);
    expect(found).toBe(false);
  });

  it("expires stale reservations", () => {
    const oldMs = Date.now() - 10 * 60_000; // 10 minutes ago
    mgr.reserve({ reservationId: "stale-1", userEntraId: "user-f", sessionId: "s1", estTokens: 100, estUsd: 0.01, reservedAt: oldMs });
    expect(mgr.concurrencyCount("user-f")).toBe(1);
    const expired = mgr.expireStale(5 * 60_000);
    expect(expired).toBe(1);
    expect(mgr.concurrencyCount("user-f")).toBe(0);
  });

  it("totalActive counts all users", () => {
    mgr.reserve({ reservationId: "a1", userEntraId: "user-x", sessionId: "s1", estTokens: 100, estUsd: 0.01, reservedAt: Date.now() });
    mgr.reserve({ reservationId: "b1", userEntraId: "user-y", sessionId: "s2", estTokens: 100, estUsd: 0.01, reservedAt: Date.now() });
    expect(mgr.totalActive()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatTracker tests
// ---------------------------------------------------------------------------

describe("HeartbeatTracker", () => {
  it("returns alive after touch", () => {
    const tracker = new HeartbeatTracker(60_000);
    tracker.touch("sess-1", "user-1");
    expect(tracker.isAlive("sess-1")).toBe(true);
  });

  it("returns not alive for unknown session", () => {
    const tracker = new HeartbeatTracker(60_000);
    expect(tracker.isAlive("unknown")).toBe(false);
  });

  it("expires sessions past TTL", () => {
    // Use a very short TTL so we can fake expiry by manipulating the clock
    // without real timer calls. Instead, construct with 1ms TTL and check
    // that the session expires immediately.
    const tracker = new HeartbeatTracker(1);
    tracker.touch("sess-2", "user-2");
    // Wait 2ms (minimal async).
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(tracker.isAlive("sess-2")).toBe(false);
        resolve();
      }, 2);
    });
  });

  it("gc removes expired sessions", async () => {
    const tracker = new HeartbeatTracker(1);
    tracker.touch("sess-3", "user-3");
    await new Promise((r) => setTimeout(r, 2));
    const removed = tracker.gc();
    expect(removed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// SlidingWindowCounter tests
// ---------------------------------------------------------------------------

describe("SlidingWindowCounter", () => {
  it("allows requests within limit", () => {
    const counter = new SlidingWindowCounter(60_000, 5);
    const result = counter.tryRecord("user-z");
    expect(result.allowed).toBe(true);
  });

  it("rejects when over limit", () => {
    const counter = new SlidingWindowCounter(60_000, 2);
    counter.tryRecord("user-q");
    counter.tryRecord("user-q");
    const result = counter.tryRecord("user-q");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("count reflects current window entries", () => {
    const counter = new SlidingWindowCounter(60_000, 10);
    counter.tryRecord("user-w");
    counter.tryRecord("user-w");
    expect(counter.count("user-w")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// MetricsCollector tests
// ---------------------------------------------------------------------------

describe("MetricsCollector", () => {
  it("renders prometheus text format", () => {
    const m = new MetricsCollector();
    m.recordReservation();
    m.recordRelease(500);
    m.record429();
    const out = m.render({ activeReservations: 3, activeSessions: 1 });
    expect(out).toContain("paperclip_reservations_total 1");
    expect(out).toContain("paperclip_429_total 1");
    expect(out).toContain("paperclip_active_reservations 3");
    expect(out).toContain("paperclip_active_sessions 1");
  });
});

// ---------------------------------------------------------------------------
// Default config smoke test
// ---------------------------------------------------------------------------

describe("DEFAULT_BUDGET_CONFIG", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_BUDGET_CONFIG.maxConcurrentPerUser).toBe(4);
    expect(DEFAULT_BUDGET_CONFIG.maxTokensPerTurn).toBe(80_000);
    expect(DEFAULT_BUDGET_CONFIG.maxUsdPerDay).toBe(25.0);
  });
});

// ---------------------------------------------------------------------------
// Phase G — rehydrate daily USD from persistence (deep-review #11)
// ---------------------------------------------------------------------------

describe("BudgetManager.rehydrateDailyUsd", () => {
  it("replaces the in-memory ledger with the snapshot", () => {
    const mgr = new BudgetManager({
      maxConcurrentPerUser: 4,
      maxTokensPerTurn: 10_000,
      maxUsdPerDay: 25.0,
    });
    expect(mgr.todayUsd("u1")).toBe(0);

    const today = new Date();
    const ymd = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    mgr.rehydrateDailyUsd(new Map([[`u1:${ymd}`, 18.0]]));

    expect(mgr.todayUsd("u1")).toBeCloseTo(18.0);
    // The check should reject any new reservation that would push past 25.
    const result = mgr.check({ userEntraId: "u1", estTokens: 100, estUsd: 8.0 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("usd_budget");
  });

  it("rehydrate is idempotent — calling again replaces the prior snapshot", () => {
    const mgr = new BudgetManager({
      maxConcurrentPerUser: 4,
      maxTokensPerTurn: 10_000,
      maxUsdPerDay: 25.0,
    });
    const today = new Date();
    const ymd = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    mgr.rehydrateDailyUsd(new Map([[`u1:${ymd}`, 5.0]]));
    mgr.rehydrateDailyUsd(new Map([[`u1:${ymd}`, 12.0]]));
    expect(mgr.todayUsd("u1")).toBeCloseTo(12.0);
  });
});

// ---------------------------------------------------------------------------
// BudgetManager — boundary / isolation / accumulation gaps. The block above
// covers the happy paths; these pin the off-by-one and cross-user contracts
// that block real-execution paths.
// ---------------------------------------------------------------------------

describe("BudgetManager — limit boundaries", () => {
  let mgr: BudgetManager;

  beforeEach(() => {
    mgr = new BudgetManager({
      maxConcurrentPerUser: 2,
      maxTokensPerTurn: 10_000,
      maxUsdPerDay: 5.0,
    });
  });

  it("allows a reservation at exactly the per-turn token limit", () => {
    // Source contract: `if (estTokens > maxTokensPerTurn)` — strict greater-than.
    const result = mgr.check({ userEntraId: "u", estTokens: 10_000, estUsd: 0.01 });
    expect(result.allowed).toBe(true);
  });

  it("rejects a reservation one token past the per-turn token limit", () => {
    const result = mgr.check({ userEntraId: "u", estTokens: 10_001, estUsd: 0.01 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("token_budget");
  });

  it("allows a reservation at exactly the daily USD limit", () => {
    // spent=0, est=5.0, max=5.0 → 0+5.0 > 5.0 is false → allowed.
    const result = mgr.check({ userEntraId: "u", estTokens: 100, estUsd: 5.0 });
    expect(result.allowed).toBe(true);
  });

  it("rejects a reservation one cent past the daily USD limit", () => {
    const result = mgr.check({ userEntraId: "u", estTokens: 100, estUsd: 5.01 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("usd_budget");
  });

  it("checks concurrency before token budget when both would fail", () => {
    // Saturate concurrency, then ask for tokens that also exceed the per-turn cap.
    // Concurrency reason must win — it's checked first in `check()`.
    for (let i = 0; i < 2; i++) {
      mgr.reserve({
        reservationId: `r${i}`,
        userEntraId: "u",
        sessionId: "s",
        estTokens: 1,
        estUsd: 0.01,
        reservedAt: Date.now(),
      });
    }
    const result = mgr.check({ userEntraId: "u", estTokens: 999_999, estUsd: 0.01 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("concurrency_limit");
  });

  it("isolates concurrency limits per user", () => {
    // user-a saturates their own quota; user-b should be unaffected.
    for (let i = 0; i < 2; i++) {
      mgr.reserve({
        reservationId: `a${i}`,
        userEntraId: "user-a",
        sessionId: "s",
        estTokens: 1,
        estUsd: 0.01,
        reservedAt: Date.now(),
      });
    }
    expect(mgr.check({ userEntraId: "user-a", estTokens: 1, estUsd: 0.01 }).allowed).toBe(false);
    expect(mgr.check({ userEntraId: "user-b", estTokens: 1, estUsd: 0.01 }).allowed).toBe(true);
  });

  it("isolates daily USD ledgers per user", () => {
    mgr.reserve({ reservationId: "r1", userEntraId: "user-a", sessionId: "s", estTokens: 1, estUsd: 4.99, reservedAt: Date.now() });
    mgr.release("r1", 4.99);
    expect(mgr.todayUsd("user-a")).toBeCloseTo(4.99);
    expect(mgr.todayUsd("user-b")).toBe(0);
    expect(mgr.check({ userEntraId: "user-b", estTokens: 1, estUsd: 4.99 }).allowed).toBe(true);
  });

  it("release accumulates USD across multiple turns", () => {
    for (const [id, usd] of [["r1", 1.5], ["r2", 0.75], ["r3", 0.25]] as const) {
      mgr.reserve({ reservationId: id, userEntraId: "u", sessionId: "s", estTokens: 1, estUsd: usd, reservedAt: Date.now() });
      mgr.release(id, usd);
    }
    expect(mgr.todayUsd("u")).toBeCloseTo(2.5);
  });

  it("release of an unknown reservation does not change the USD ledger", () => {
    mgr.reserve({ reservationId: "r1", userEntraId: "u", sessionId: "s", estTokens: 1, estUsd: 1.0, reservedAt: Date.now() });
    mgr.release("r1", 1.0);
    expect(mgr.todayUsd("u")).toBeCloseTo(1.0);

    const found = mgr.release("does-not-exist", 99.0);
    expect(found).toBe(false);
    expect(mgr.todayUsd("u")).toBeCloseTo(1.0); // unchanged
  });
});

describe("BudgetManager.expireStale", () => {
  it("only removes reservations older than maxAgeMs and leaves fresh ones in place", () => {
    const mgr = new BudgetManager(DEFAULT_BUDGET_CONFIG);
    const now = Date.now();
    mgr.reserve({ reservationId: "fresh", userEntraId: "u", sessionId: "s", estTokens: 1, estUsd: 0.01, reservedAt: now });
    mgr.reserve({ reservationId: "stale", userEntraId: "u", sessionId: "s", estTokens: 1, estUsd: 0.01, reservedAt: now - 10 * 60_000 });
    expect(mgr.concurrencyCount("u")).toBe(2);

    const expired = mgr.expireStale(5 * 60_000);

    expect(expired).toBe(1);
    expect(mgr.concurrencyCount("u")).toBe(1);
  });

  it("expires stale reservations across multiple users in one pass", () => {
    const mgr = new BudgetManager(DEFAULT_BUDGET_CONFIG);
    const old = Date.now() - 10 * 60_000;
    mgr.reserve({ reservationId: "a-stale", userEntraId: "user-a", sessionId: "s", estTokens: 1, estUsd: 0.01, reservedAt: old });
    mgr.reserve({ reservationId: "b-stale", userEntraId: "user-b", sessionId: "s", estTokens: 1, estUsd: 0.01, reservedAt: old });
    mgr.reserve({ reservationId: "c-fresh", userEntraId: "user-c", sessionId: "s", estTokens: 1, estUsd: 0.01, reservedAt: Date.now() });

    expect(mgr.expireStale(5 * 60_000)).toBe(2);
    expect(mgr.totalActive()).toBe(1);
    expect(mgr.concurrencyCount("user-c")).toBe(1);
  });
});

describe("BudgetManager.rehydrateDailyUsd — clearing semantics", () => {
  it("an empty snapshot clears the in-memory ledger", () => {
    const mgr = new BudgetManager(DEFAULT_BUDGET_CONFIG);
    mgr.reserve({ reservationId: "r1", userEntraId: "u", sessionId: "s", estTokens: 1, estUsd: 3.0, reservedAt: Date.now() });
    mgr.release("r1", 3.0);
    expect(mgr.todayUsd("u")).toBeCloseTo(3.0);

    mgr.rehydrateDailyUsd(new Map());
    expect(mgr.todayUsd("u")).toBe(0);
  });

  it("releases after rehydrate accumulate on top of the rehydrated total", () => {
    const mgr = new BudgetManager(DEFAULT_BUDGET_CONFIG);
    const today = new Date();
    const ymd = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
    mgr.rehydrateDailyUsd(new Map([[`u:${ymd}`, 10.0]]));

    mgr.reserve({ reservationId: "r-after", userEntraId: "u", sessionId: "s", estTokens: 1, estUsd: 2.5, reservedAt: Date.now() });
    mgr.release("r-after", 2.5);

    expect(mgr.todayUsd("u")).toBeCloseTo(12.5);
  });
});

describe("BudgetManager — usd_budget retryAfterMs ≈ ms until UTC midnight", () => {
  beforeEach(() => {
    // Pin the wall clock so the maths is deterministic. Pick noon UTC on a
    // fixed date so both the bucket date and the "ms until next UTC midnight"
    // are unambiguous.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-08T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the exact ms remaining until the next UTC day boundary", () => {
    const mgr = new BudgetManager({ maxConcurrentPerUser: 4, maxTokensPerTurn: 10_000, maxUsdPerDay: 5.0 });
    // Push spend over the cap so the next check falls into the usd_budget branch.
    mgr.reserve({ reservationId: "r", userEntraId: "u", sessionId: "s", estTokens: 1, estUsd: 5.0, reservedAt: Date.now() });
    mgr.release("r", 5.0);

    const result = mgr.check({ userEntraId: "u", estTokens: 1, estUsd: 0.01 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("usd_budget");
    // 12 hours until the next UTC midnight, exactly.
    expect(result.retryAfterMs).toBe(12 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// HeartbeatTracker — the existing block covers isAlive + gc; these add
// `get()`, activeCount, and the touch() refresh contract used by sessions
// that heartbeat every 30s with a 90s TTL.
// ---------------------------------------------------------------------------

describe("HeartbeatTracker.get and activeCount", () => {
  it("get() returns the entry when alive, undefined when expired", async () => {
    const tracker = new HeartbeatTracker(50);
    tracker.touch("sess-a", "user-1");
    const entry = tracker.get("sess-a");
    expect(entry?.userEntraId).toBe("user-1");
    expect(entry?.sessionId).toBe("sess-a");

    await new Promise((r) => setTimeout(r, 60));
    expect(tracker.get("sess-a")).toBeUndefined();
  });

  it("activeCount only counts sessions still inside the TTL window", async () => {
    const tracker = new HeartbeatTracker(50);
    tracker.touch("alive-1", "u1");
    tracker.touch("expiring-1", "u2");
    expect(tracker.activeCount()).toBe(2);

    await new Promise((r) => setTimeout(r, 60));
    // Both have aged out at this point — refresh just one.
    tracker.touch("alive-1", "u1");
    expect(tracker.activeCount()).toBe(1);
  });

  it("touch() refreshes lastSeen so a session past its initial TTL stays alive", async () => {
    const tracker = new HeartbeatTracker(50);
    tracker.touch("s", "u");

    await new Promise((r) => setTimeout(r, 30));
    tracker.touch("s", "u"); // refresh before expiry
    await new Promise((r) => setTimeout(r, 30));

    // 60ms has elapsed since the first touch, but only 30ms since the most
    // recent — so the session should still be alive.
    expect(tracker.isAlive("s")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SlidingWindowCounter — existing block covers happy / over-limit / count.
// These cover per-key isolation and window rollover (the core sliding-window
// contract that's only tested implicitly today).
// ---------------------------------------------------------------------------

describe("SlidingWindowCounter — isolation and rollover", () => {
  it("rate-limits per key, not globally", () => {
    const counter = new SlidingWindowCounter(60_000, 1);
    expect(counter.tryRecord("user-a").allowed).toBe(true);
    // user-a is now saturated; user-b should still get a slot.
    expect(counter.tryRecord("user-a").allowed).toBe(false);
    expect(counter.tryRecord("user-b").allowed).toBe(true);
  });

  it("frees a slot after the window rolls over", async () => {
    const counter = new SlidingWindowCounter(40, 1);
    expect(counter.tryRecord("u").allowed).toBe(true);
    expect(counter.tryRecord("u").allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(counter.tryRecord("u").allowed).toBe(true);
  });

  it("retryAfterMs equals the remaining lifetime of the oldest in-window timestamp", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-08T00:00:00.000Z"));
      const counter = new SlidingWindowCounter(60_000, 1);
      counter.tryRecord("u"); // recorded at t=0

      vi.setSystemTime(new Date("2026-05-08T00:00:20.000Z")); // +20s
      const result = counter.tryRecord("u");
      expect(result.allowed).toBe(false);
      // Oldest timestamp was at t=0; window=60_000; now=20_000.
      // retryAfterMs = 0 + 60000 - 20000 = 40000.
      expect(result.retryAfterMs).toBe(40_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
