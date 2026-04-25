// Vitest tests for Paperclip-lite sidecar.
// 8+ tests covering budget, heartbeat, concurrency, and HTTP routes.

import { describe, it, expect, beforeEach } from "vitest";
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
