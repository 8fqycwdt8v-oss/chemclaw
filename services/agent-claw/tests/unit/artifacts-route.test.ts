// Tests for POST /api/artifacts/:id/maturity and GET /api/artifacts/:id — Phase C.6

import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import type { Pool, QueryResult } from "pg";
import { registerArtifactsRoutes } from "../../src/routes/artifacts.js";

// ---------------------------------------------------------------------------
// Stub pool builder
// ---------------------------------------------------------------------------

interface UpdateResult {
  id: string;
  maturity: string;
}

interface ArtifactRow {
  id: string;
  kind: string;
  payload: unknown;
  maturity: string;
  confidence_ensemble: unknown;
  created_at: string;
}

function makePool(opts: {
  updateResult?: UpdateResult | null;
  artifactRow?: ArtifactRow | null;
}): Pool {
  return {
    connect: async () => {
      const client = {
        query: async <T = unknown>(sql: string, _params?: unknown[]): Promise<QueryResult<T>> => {
          if (sql.startsWith("SET LOCAL") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) {
            return { rows: [] as T[], rowCount: 0, command: "SET", oid: 0, fields: [] };
          }
          if (sql.includes("UPDATE artifacts")) {
            const row = opts.updateResult ?? null;
            return {
              rows: (row ? [row] : []) as unknown as T[],
              rowCount: row ? 1 : 0,
              command: "UPDATE",
              oid: 0,
              fields: [],
            };
          }
          if (sql.includes("SELECT") && sql.includes("FROM artifacts")) {
            const row = opts.artifactRow ?? null;
            return {
              rows: (row ? [row] : []) as unknown as T[],
              rowCount: row ? 1 : 0,
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

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

async function buildApp(opts: {
  updateResult?: UpdateResult | null;
  artifactRow?: ArtifactRow | null;
}) {
  const app = Fastify({ logger: false });
  const pool = makePool(opts);
  registerArtifactsRoutes(app, {
    pool,
    getUser: () => "test@example.com",
  });
  return await app;
}

// ---------------------------------------------------------------------------
// POST /api/artifacts/:id/maturity
// ---------------------------------------------------------------------------

describe("POST /api/artifacts/:id/maturity", () => {
  it("returns 400 for invalid UUID param", async () => {
    const app = await buildApp({ updateResult: null });
    const resp = await app.inject({
      method: "POST",
      url: "/api/artifacts/not-a-uuid/maturity",
      body: { tier: "WORKING" },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("returns 400 for invalid tier value", async () => {
    const app = await buildApp({ updateResult: null });
    const resp = await app.inject({
      method: "POST",
      url: `/api/artifacts/${VALID_UUID}/maturity`,
      body: { tier: "INVALID_TIER" },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("returns 404 when artifact not found", async () => {
    const app = await buildApp({ updateResult: null });
    const resp = await app.inject({
      method: "POST",
      url: `/api/artifacts/${VALID_UUID}/maturity`,
      body: { tier: "WORKING" },
    });
    expect(resp.statusCode).toBe(404);
  });

  it("returns 200 with updated maturity on success", async () => {
    const app = await buildApp({
      updateResult: { id: VALID_UUID, maturity: "WORKING" },
    });
    const resp = await app.inject({
      method: "POST",
      url: `/api/artifacts/${VALID_UUID}/maturity`,
      body: { tier: "WORKING" },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.artifact_id).toBe(VALID_UUID);
    expect(body.maturity).toBe("WORKING");
  });

  it("accepts FOUNDATION tier", async () => {
    const app = await buildApp({
      updateResult: { id: VALID_UUID, maturity: "FOUNDATION" },
    });
    const resp = await app.inject({
      method: "POST",
      url: `/api/artifacts/${VALID_UUID}/maturity`,
      body: { tier: "FOUNDATION" },
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).maturity).toBe("FOUNDATION");
  });
});

// ---------------------------------------------------------------------------
// GET /api/artifacts/:id
// ---------------------------------------------------------------------------

describe("GET /api/artifacts/:id", () => {
  it("returns 404 when artifact not found", async () => {
    const app = await buildApp({ artifactRow: null });
    const resp = await app.inject({
      method: "GET",
      url: `/api/artifacts/${VALID_UUID}`,
    });
    expect(resp.statusCode).toBe(404);
  });

  it("returns 200 with artifact data when found", async () => {
    const app = await buildApp({
      artifactRow: {
        id: VALID_UUID,
        kind: "propose_hypothesis",
        payload: { hypothesis_id: "h-1" },
        maturity: "EXPLORATORY",
        confidence_ensemble: null,
        created_at: "2026-04-23T10:00:00.000Z",
      },
    });
    const resp = await app.inject({
      method: "GET",
      url: `/api/artifacts/${VALID_UUID}`,
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.id).toBe(VALID_UUID);
    expect(body.kind).toBe("propose_hypothesis");
    expect(body.maturity).toBe("EXPLORATORY");
  });
});
