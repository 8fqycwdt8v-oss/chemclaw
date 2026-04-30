// Paperclip-lite sidecar — Fastify app on port 3200.
//
// API:
//   POST   /reserve                 → { reservation_id } or 429
//   POST   /release                 → 200
//   POST   /heartbeat               → 200
//   GET    /heartbeat/:session_id   → 200 alive | 410 gone
//   GET    /metrics                 → Prometheus text format
//   GET    /healthz                 → 200 always
//
// GxP-stripped: no approval gates, no audit packets, no WORM.
// Budget + heartbeat + concurrency only.

import Fastify from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { BudgetManager } from "./budget.js";
import { HeartbeatTracker } from "./heartbeat.js";
import { MetricsCollector } from "./metrics.js";
import { PaperclipState } from "./persistence.js";

// ---------------------------------------------------------------------------
// Config from env
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PAPERCLIP_PORT ?? 3200);
const HOST = process.env.PAPERCLIP_HOST ?? "0.0.0.0";
const MAX_CONCURRENT = Number(process.env.PAPERCLIP_MAX_CONCURRENT ?? 4);
const MAX_TOKENS_PER_TURN = Number(process.env.PAPERCLIP_MAX_TOKENS ?? 80_000);
const MAX_USD_PER_DAY = Number(process.env.PAPERCLIP_MAX_USD_PER_DAY ?? 25.0);
const STALE_RESERVATION_MS = Number(process.env.PAPERCLIP_STALE_MS ?? 5 * 60_000);
const HEARTBEAT_TTL_MS = Number(process.env.PAPERCLIP_HEARTBEAT_TTL_MS ?? 90_000);

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

const budgetMgr = new BudgetManager({
  maxConcurrentPerUser: MAX_CONCURRENT,
  maxTokensPerTurn: MAX_TOKENS_PER_TURN,
  maxUsdPerDay: MAX_USD_PER_DAY,
});

const heartbeat = new HeartbeatTracker(HEARTBEAT_TTL_MS);
const metrics = new MetricsCollector();

// ---------------------------------------------------------------------------
// Persistence (Phase G — closes deep-review #11).
// ---------------------------------------------------------------------------
//
// Hot path stays in-process; Postgres is the durable shadow so a sidecar
// restart doesn't reset the daily-USD ledger. When PAPERCLIP_PG_DSN is
// unset (single-instance dev / tests), the persistence object is null and
// the sidecar matches its pre-Phase-G behaviour exactly.

const PG_DSN = process.env.PAPERCLIP_PG_DSN;
const persistence: PaperclipState | null = PG_DSN
  ? new PaperclipState(new Pool({ connectionString: PG_DSN }))
  : null;

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ReserveSchema = z.object({
  user_entra_id: z.string().min(1),
  session_id: z.string().min(1),
  est_tokens: z.number().int().positive(),
  est_usd: z.number().nonnegative(),
});

const ReleaseSchema = z.object({
  reservation_id: z.string().uuid(),
  actual_tokens: z.number().int().nonnegative().optional(),
  actual_usd: z.number().nonnegative().optional(),
});

const HeartbeatPostSchema = z.object({
  user_entra_id: z.string().min(1),
  session_id: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Fastify app
// ---------------------------------------------------------------------------

export function buildApp() {
  const app = Fastify({ logger: true });

  // ── GET /healthz ──────────────────────────────────────────────────────────
  app.get("/healthz", async (_req, reply) => {
    return await reply.code(200).send({ status: "ok" });
  });

  // Alias: GET /heartbeat/health (used as compose healthcheck target)
  app.get("/heartbeat/health", async (_req, reply) => {
    return await reply.code(200).send({ status: "ok" });
  });

  // ── POST /reserve ─────────────────────────────────────────────────────────
  app.post("/reserve", async (req, reply) => {
    const parsed = ReserveSchema.safeParse(req.body);
    if (!parsed.success) {
      return await reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }
    const { user_entra_id, session_id, est_tokens, est_usd } = parsed.data;

    const check = budgetMgr.check({ userEntraId: user_entra_id, estTokens: est_tokens, estUsd: est_usd });
    if (!check.allowed) {
      metrics.record429();
      const retryAfter = check.retryAfterMs !== undefined
        ? Math.ceil(check.retryAfterMs / 1000)
        : 30;
      return await reply
        .code(429)
        .header("Retry-After", String(retryAfter))
        .send({ error: "budget_exceeded", reason: check.reason, retry_after_seconds: retryAfter });
    }

    const reservationId = randomUUID();
    budgetMgr.reserve({
      reservationId,
      userEntraId: user_entra_id,
      sessionId: session_id,
      estTokens: est_tokens,
      estUsd: est_usd,
      reservedAt: Date.now(),
    });

    metrics.recordReservation();

    // Phase G: mirror the reservation into Postgres so a sidecar restart
    // doesn't lose the daily-USD ledger.
    if (persistence) {
      await persistence.recordReserved({
        reservationId,
        userEntraId: user_entra_id,
        sessionId: session_id,
        estTokens: est_tokens,
        estUsd: est_usd,
      });
    }

    return await reply.code(200).send({ reservation_id: reservationId });
  });

  // ── POST /release ─────────────────────────────────────────────────────────
  app.post("/release", async (req, reply) => {
    const parsed = ReleaseSchema.safeParse(req.body);
    if (!parsed.success) {
      return await reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }
    const { reservation_id, actual_tokens: _tokens, actual_usd } = parsed.data;

    const found = budgetMgr.release(reservation_id, actual_usd ?? 0);
    if (!found) {
      return await reply.code(404).send({ error: "reservation_not_found" });
    }

    // Record turn duration (not tracked individually — just accumulate ms).
    metrics.recordRelease(0);

    // Phase G: mirror the release into Postgres so the durable ledger
    // reflects actual usage. Best-effort — a DB outage doesn't block.
    if (persistence) {
      await persistence.recordReleased(
        reservation_id,
        parsed.data.actual_tokens ?? 0,
        actual_usd ?? 0,
      );
    }

    return await reply.code(200).send({ status: "released" });
  });

  // ── POST /heartbeat ───────────────────────────────────────────────────────
  app.post("/heartbeat", async (req, reply) => {
    const parsed = HeartbeatPostSchema.safeParse(req.body);
    if (!parsed.success) {
      return await reply.code(400).send({ error: "invalid_input", detail: parsed.error.issues });
    }
    heartbeat.touch(parsed.data.session_id, parsed.data.user_entra_id);
    return await reply.code(200).send({ status: "ok" });
  });

  // ── GET /heartbeat/:session_id ────────────────────────────────────────────
  app.get<{ Params: { session_id: string } }>("/heartbeat/:session_id", async (req, reply) => {
    const { session_id } = req.params;
    if (heartbeat.isAlive(session_id)) {
      return await reply.code(200).send({ status: "alive" });
    }
    return await reply.code(410).send({ status: "gone" });
  });

  // ── GET /metrics ──────────────────────────────────────────────────────────
  app.get("/metrics", async (_req, reply) => {
    const text = metrics.render({
      activeReservations: budgetMgr.totalActive(),
      activeSessions: heartbeat.activeCount(),
    });
    reply.raw.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    reply.raw.statusCode = 200;
    reply.raw.end(text);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Periodic cleanup
// ---------------------------------------------------------------------------

function startCleanupLoop(intervalMs = 60_000): void {
  const run = () => {
    budgetMgr.expireStale(STALE_RESERVATION_MS);
    heartbeat.gc();
    setTimeout(run, intervalMs);
  };
  setTimeout(run, intervalMs);
}

// ---------------------------------------------------------------------------
// Horizontal-scaling refresh (Phase G next-pass — deep-review #12).
// ---------------------------------------------------------------------------
//
// When paperclip-lite is scaled to N replicas, each holds an independent
// in-process daily-USD ledger and the effective per-user daily cap becomes
// N×configured (a 4-replica cluster lets a user spend $25 × 4 = $100/day).
//
// Strategy: every PAPERCLIP_REFRESH_INTERVAL_MS (default 60_000) re-read
// today's totals from paperclip_state and replace the in-process map.
// Replicas converge with bounded staleness — at worst one minute of
// over-spend per replica per refresh cycle. This is a much simpler
// design than a distributed lock and is sufficient for the small-team
// pharma deployment profile (4 users typical, daily cap measured in $).

const REFRESH_INTERVAL_MS = Number(process.env.PAPERCLIP_REFRESH_INTERVAL_MS ?? 60_000);

function startLedgerRefreshLoop(p: PaperclipState, log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void }): void {
  const run = async () => {
    try {
      const snapshot = await p.rehydrateDailyUsd();
      budgetMgr.rehydrateDailyUsd(snapshot);
      log.info({ entries: snapshot.size }, "paperclip refreshed daily-USD ledger");
    } catch (err) {
      log.warn({ err }, "paperclip ledger refresh failed (non-fatal)");
    }
    setTimeout(() => void run(), REFRESH_INTERVAL_MS);
  };
  setTimeout(() => void run(), REFRESH_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Startup (skipped in test imports)
// ---------------------------------------------------------------------------

if (process.env.PAPERCLIP_SKIP_START !== "true") {
  const app = buildApp();

  // Rehydrate the daily-USD ledger from paperclip_state BEFORE opening
  // for traffic. A 23:59 UTC restart otherwise zeroes everyone's spend
  // and lets a user double-spend their daily cap. Awaited so the first
  // /reserve sees the historical totals rather than racing the rehydrate.
  const startup = (async () => {
    if (persistence) {
      try {
        const snapshot = await persistence.rehydrateDailyUsd();
        budgetMgr.rehydrateDailyUsd(snapshot);
        app.log.info({ entries: snapshot.size }, "paperclip rehydrated daily-USD ledger");
      } catch (err) {
        app.log.warn({ err }, "paperclip rehydrate failed; starting with empty ledger");
      }
    }

    app.listen({ host: HOST, port: PORT }, (err) => {
      if (err) {
        app.log.error(err);
        process.exit(1);
      }
      app.log.info({ port: PORT }, "Paperclip-lite started");
    });
  })();

  // Surface unhandled rejections from the IIFE so Node doesn't silently swallow.
  startup.catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });

  startCleanupLoop();

  // Phase G #12: in multi-replica deployments, periodically pull
  // today's totals from paperclip_state so replicas converge on a
  // shared daily-USD view. Single-replica deployments still benefit
  // — a manual UPDATE to paperclip_state propagates within a minute.
  if (persistence) {
    startLedgerRefreshLoop(persistence, app.log);
  }
}

export { budgetMgr, heartbeat, metrics };
