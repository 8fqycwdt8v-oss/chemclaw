// Tests for routes/optimizer.ts — the four read-only GETs gated by the
// canonical admin_roles check (middleware/require-admin.ts).
//
// BACKLOG-80 noted no `tests/unit/*-route.test.ts` covered the registered
// endpoints; this file pins the admin gate (200 vs 403) and the basic
// shape of the responses for /runs and /promotions.
//
// We use a SQL-string-matching stub `pg.Pool` (same pattern as
// artifacts-route.test.ts) — no live Postgres, no withUserContext mocks
// to keep behind. The route deliberately uses withUserContext +
// withSystemContext, both of which call SET LOCAL inside a BEGIN/COMMIT,
// so the stub has to handle SET / BEGIN / COMMIT no-ops too.

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { Pool, QueryResult } from "pg";
import { registerOptimizerRoutes } from "../../../src/routes/optimizer.js";

// ---------------------------------------------------------------------------
// Pool stub — branches on the SQL fragment.
// ---------------------------------------------------------------------------

interface StubOpts {
  /** True iff the gateAdmin EXISTS query should report has_admin=true. */
  isAdmin: boolean;
  /** Rows returned for the catalog SELECTs (runs / promotions / shadow / golden). */
  catalogRows?: Array<Record<string, unknown>>;
}

function makePool(opts: StubOpts): Pool {
  return {
    connect: async () => {
      const client = {
        query: async <T = unknown>(sql: string): Promise<QueryResult<T>> => {
          const trimmed = sql.trim();
          if (
            trimmed.startsWith("BEGIN") ||
            trimmed.startsWith("COMMIT") ||
            trimmed.startsWith("ROLLBACK") ||
            trimmed.startsWith("SELECT set_config")
          ) {
            return { rows: [] as T[], rowCount: 0, command: "SET", oid: 0, fields: [] };
          }
          // Canonical admin gate calls SELECT current_user_is_admin($1, $2)
          // (middleware/require-admin.ts → admin_roles via SECURITY DEFINER).
          if (trimmed.includes("current_user_is_admin")) {
            return {
              rows: [{ is_admin: opts.isAdmin }] as unknown as T[],
              rowCount: 1,
              command: "SELECT",
              oid: 0,
              fields: [],
            };
          }
          // Any other SELECT returns the canned catalog rows.
          if (trimmed.startsWith("SELECT")) {
            const rows = (opts.catalogRows ?? []) as unknown as T[];
            return {
              rows,
              rowCount: rows.length,
              command: "SELECT",
              oid: 0,
              fields: [],
            };
          }
          return { rows: [] as T[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
        },
        release: () => {},
      };
      return client;
    },
  } as unknown as Pool;
}

async function buildApp(opts: StubOpts) {
  const app = Fastify({ logger: false });
  registerOptimizerRoutes(app, {
    pool: makePool(opts),
    getUser: () => "test@example.com",
  });
  return await app;
}

// ---------------------------------------------------------------------------
// Admin gate
// ---------------------------------------------------------------------------

describe("optimizer routes — admin gate", () => {
  it("returns 403 on /api/optimizer/runs when caller is not admin", async () => {
    const app = await buildApp({ isAdmin: false });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/runs" });
    expect(resp.statusCode).toBe(403);
    expect(JSON.parse(resp.body).error).toBe("forbidden");
  });

  it("returns 403 on /api/optimizer/promotions when caller is not admin", async () => {
    const app = await buildApp({ isAdmin: false });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/promotions" });
    expect(resp.statusCode).toBe(403);
  });

  it("returns 403 on /api/optimizer/shadow when caller is not admin", async () => {
    const app = await buildApp({ isAdmin: false });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/shadow" });
    expect(resp.statusCode).toBe(403);
  });

  it("returns 403 on /api/optimizer/golden when caller is not admin", async () => {
    const app = await buildApp({ isAdmin: false });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/golden" });
    expect(resp.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("optimizer routes — admin happy path", () => {
  it("GET /api/optimizer/runs returns the registry rows in `runs`", async () => {
    const fakeRow = {
      prompt_name: "agent_main",
      version: 7,
      active: true,
      shadow_until: null,
      gepa_metadata: { score: 0.91, generation: 4 },
      created_at: "2026-04-30T10:00:00.000Z",
    };
    const app = await buildApp({ isAdmin: true, catalogRows: [fakeRow] });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/runs" });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].prompt_name).toBe("agent_main");
    expect(body.runs[0].version).toBe(7);
  });

  it("GET /api/optimizer/promotions returns rows in `events`", async () => {
    const fakeEvent = {
      skill_name: "yield_predict",
      version: 3,
      event_type: "promoted_org",
      reason: "score 0.92 ≥ threshold",
      metadata: {},
      created_at: "2026-04-29T08:30:00.000Z",
    };
    const app = await buildApp({ isAdmin: true, catalogRows: [fakeEvent] });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/promotions" });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].event_type).toBe("promoted_org");
  });

  it("GET /api/optimizer/shadow returns aggregated rows in `shadows`", async () => {
    const aggRow = {
      prompt_name: "agent_main",
      version: 8,
      mean_score: "0.87",
      run_count: "12",
      first_run_at: "2026-04-25T00:00:00.000Z",
      last_run_at: "2026-04-30T00:00:00.000Z",
    };
    const app = await buildApp({ isAdmin: true, catalogRows: [aggRow] });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/shadow" });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).shadows).toHaveLength(1);
  });

  it("GET /api/optimizer/golden returns rows in `scores`", async () => {
    const goldenRow = {
      prompt_name: "agent_main",
      version: 7,
      score: 0.93,
      per_class_scores: { recall: 0.91, precision: 0.95 },
      run_at: "2026-04-30T01:00:00.000Z",
    };
    const app = await buildApp({ isAdmin: true, catalogRows: [goldenRow] });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/golden" });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).scores).toHaveLength(1);
  });

  it("returns empty list when catalog is empty", async () => {
    const app = await buildApp({ isAdmin: true, catalogRows: [] });
    const resp = await app.inject({ method: "GET", url: "/api/optimizer/runs" });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).runs).toEqual([]);
  });
});
