// Tests for /api/admin/config/* and /api/admin/feature-flags routes.
//
// Phase 2 of the configuration concept (Initiatives 1 + 6).

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import type { Pool, QueryResult } from "pg";
import { registerAdminRoutes } from "../../src/routes/admin/index.js";
import {
  ConfigRegistry,
  setConfigRegistry,
} from "../../src/config/registry.js";
import {
  FeatureFlagRegistry,
  setFeatureFlagRegistry,
} from "../../src/config/flags.js";

interface MockState {
  isAdminResult: boolean;
  // role-aware admin check: caller role + scope_id → bool
  scopedAdmin: Map<string, boolean>;
  configRows: Array<{ scope: string; scope_id: string; key: string; value: unknown; description: string | null; updated_at: string; updated_by: string }>;
  configUpserts: Array<{ scope: string; scope_id: string; key: string; value: string }>;
  configDeletes: Array<{ scope: string; scope_id: string; key: string }>;
  flagRows: Array<{ key: string; enabled: boolean; scope_rule: unknown; description: string; created_at: string; updated_at: string; updated_by: string }>;
  flagUpserts: Array<{ key: string; enabled: boolean; description: string }>;
  flagDeletes: string[];
  auditInserts: Array<{ actor: string; action: string; target: string }>;
}

function makePool(state: MockState): Pool {
  return {
    connect: async () => ({
      query: async <T = unknown>(
        sql: string,
        params?: unknown[],
      ): Promise<QueryResult<T>> => {
        if (
          sql.startsWith("BEGIN") ||
          sql.startsWith("COMMIT") ||
          sql.startsWith("ROLLBACK") ||
          sql.startsWith("SELECT set_config")
        ) {
          return { rows: [] as T[], rowCount: 0, command: "SET", oid: 0, fields: [] };
        }
        if (sql.includes("current_user_is_admin")) {
          // Either default isAdminResult or scoped lookup
          if (params && params.length >= 2) {
            const role = params[0] as string | null;
            const scope = params[1] as string | null;
            const k = `${role ?? ""}:${scope ?? ""}`;
            const ok = state.scopedAdmin.get(k) ?? state.isAdminResult;
            return { rows: [{ is_admin: ok }] as unknown as T[], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
          }
          return { rows: [{ is_admin: state.isAdminResult }] as unknown as T[], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
        }
        // config_settings ----------------------------------------------------
        if (sql.includes("FROM config_settings") && (sql.includes("SELECT scope") || sql.includes("SELECT value"))) {
          if (sql.includes("SELECT value")) {
            // Single-row before-value lookup
            const p = params ?? [];
            return { rows: [{ value: state.configRows.find(r => r.scope === p[0] && r.scope_id === p[1] && r.key === p[2])?.value ?? null }] as unknown as T[], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
          }
          return { rows: state.configRows as unknown as T[], rowCount: state.configRows.length, command: "SELECT", oid: 0, fields: [] };
        }
        if (sql.includes("INSERT INTO config_settings")) {
          const p = params ?? [];
          state.configUpserts.push({ scope: p[0] as string, scope_id: p[1] as string, key: p[2] as string, value: p[3] as string });
          return { rows: [] as T[], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
        }
        if (sql.includes("DELETE FROM config_settings")) {
          const p = params ?? [];
          const found = state.configRows.find(r => r.scope === p[0] && r.scope_id === p[1] && r.key === p[2]);
          state.configDeletes.push({ scope: p[0] as string, scope_id: p[1] as string, key: p[2] as string });
          if (found) {
            return { rows: [{ value: found.value }] as unknown as T[], rowCount: 1, command: "DELETE", oid: 0, fields: [] };
          }
          return { rows: [] as T[], rowCount: 0, command: "DELETE", oid: 0, fields: [] };
        }
        // feature_flags ------------------------------------------------------
        if (sql.includes("FROM feature_flags")) {
          if (sql.includes("WHERE key = $1")) {
            const row = state.flagRows.find(r => r.key === params?.[0]) ?? null;
            return { rows: row ? [row] as unknown as T[] : [], rowCount: row ? 1 : 0, command: "SELECT", oid: 0, fields: [] };
          }
          return { rows: state.flagRows as unknown as T[], rowCount: state.flagRows.length, command: "SELECT", oid: 0, fields: [] };
        }
        if (sql.includes("INSERT INTO feature_flags")) {
          state.flagUpserts.push({ key: params?.[0] as string, enabled: params?.[1] as boolean, description: params?.[3] as string });
          return { rows: [] as T[], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
        }
        if (sql.includes("DELETE FROM feature_flags")) {
          const row = state.flagRows.find(r => r.key === params?.[0]) ?? null;
          state.flagDeletes.push(params?.[0] as string);
          return { rows: row ? [row] as unknown as T[] : [], rowCount: row ? 1 : 0, command: "DELETE", oid: 0, fields: [] };
        }
        // admin_audit_log ----------------------------------------------------
        if (sql.includes("INSERT INTO admin_audit_log")) {
          state.auditInserts.push({ actor: params?.[0] as string, action: params?.[1] as string, target: params?.[2] as string });
          return { rows: [{ id: `a${state.auditInserts.length}` }] as unknown as T[], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
        }
        return { rows: [] as T[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
}

function makeState(overrides: Partial<MockState> = {}): MockState {
  return {
    isAdminResult: true,
    scopedAdmin: new Map(),
    configRows: [],
    configUpserts: [],
    configDeletes: [],
    flagRows: [],
    flagUpserts: [],
    flagDeletes: [],
    auditInserts: [],
    ...overrides,
  };
}

async function buildApp(state: MockState, callerId = "admin@example.com") {
  const app = Fastify({ logger: false });
  const pool = makePool(state);
  // Initialise the singletons so admin handlers' invalidate() calls don't throw.
  setConfigRegistry(new ConfigRegistry(pool, 60_000));
  setFeatureFlagRegistry(new FeatureFlagRegistry(pool, 60_000));
  registerAdminRoutes(app, pool, () => callerId);
  return await app;
}

beforeEach(() => {
  delete process.env.AGENT_ADMIN_USERS;
});

describe("PATCH /api/admin/config/:scope/:scope_id?key=X", () => {
  it("403 when caller is not an admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/admin/config/global/_?key=agent.max_active_skills",
      payload: { value: 16 },
    });
    expect(resp.statusCode).toBe(403);
    expect(state.configUpserts).toHaveLength(0);
  });

  it("400 when scope is invalid", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/admin/config/banana/x?key=k",
      payload: { value: 1 },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("400 when global scope uses a non-placeholder scope_id", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/admin/config/global/some-id?key=k",
      payload: { value: 1 },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("upserts and audits a global setting", async () => {
    const state = makeState();
    const app = await buildApp(state, "boss@x.com");
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/admin/config/global/_?key=agent.max_active_skills",
      payload: { value: 16, description: "more skills", reason: "team grew" },
    });
    expect(resp.statusCode).toBe(200);
    expect(state.configUpserts).toHaveLength(1);
    expect(state.configUpserts[0]).toMatchObject({ scope: "global", scope_id: "", key: "agent.max_active_skills" });
    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0].action).toBe("config.set");
  });

  it("403 when org_admin scope_id mismatches the URL scope_id", async () => {
    const state = makeState({
      isAdminResult: false,
      scopedAdmin: new Map([["org_admin:other-org", true]]),
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/admin/config/org/acme?key=agent.max_active_skills",
      payload: { value: 16 },
    });
    expect(resp.statusCode).toBe(403);
  });

  it("allows org_admin who matches the URL scope_id", async () => {
    const state = makeState({
      isAdminResult: false,
      scopedAdmin: new Map([["org_admin:acme", true]]),
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "PATCH",
      url: "/api/admin/config/org/acme?key=agent.max_active_skills",
      payload: { value: 16 },
    });
    expect(resp.statusCode).toBe(200);
  });
});

describe("DELETE /api/admin/config/:scope/:scope_id?key=X", () => {
  it("403 when caller is not an admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/config/global/_?key=k",
    });
    expect(resp.statusCode).toBe(403);
  });

  it("returns deleted=false when row absent (still 200)", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/config/global/_?key=k",
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).deleted).toBe(false);
    expect(state.auditInserts).toHaveLength(0);
  });

  it("audits when an actual row is deleted", async () => {
    const state = makeState({
      configRows: [{ scope: "global", scope_id: "", key: "k", value: 7, description: null, updated_at: "", updated_by: "" }],
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/config/global/_?key=k",
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).deleted).toBe(true);
    expect(state.auditInserts[0].action).toBe("config.delete");
  });
});

describe("GET /api/admin/config", () => {
  it("403 for non-admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({ method: "GET", url: "/api/admin/config" });
    expect(resp.statusCode).toBe(403);
  });

  it("returns configured rows", async () => {
    const state = makeState({
      configRows: [{ scope: "global", scope_id: "", key: "k1", value: 1, description: null, updated_at: "2026-04-30T00:00:00Z", updated_by: "boss@x.com" }],
    });
    const app = await buildApp(state);
    const resp = await app.inject({ method: "GET", url: "/api/admin/config" });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.count).toBe(1);
    expect(body.settings[0].key).toBe("k1");
  });
});

describe("POST /api/admin/feature-flags/:key", () => {
  it("403 for non-admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/feature-flags/agent.confidence_cross_model",
      payload: { enabled: true, description: "desc" },
    });
    expect(resp.statusCode).toBe(403);
  });

  it("400 for invalid key", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/feature-flags/has spaces",
      payload: { enabled: true, description: "desc" },
    });
    expect(resp.statusCode).toBe(400);
  });

  it("upserts and audits create-vs-update correctly", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/feature-flags/agent.x",
      payload: { enabled: true, description: "first time" },
    });
    expect(resp.statusCode).toBe(200);
    expect(state.flagUpserts).toHaveLength(1);
    expect(state.auditInserts[0].action).toBe("feature_flag.create");
  });

  it("logs feature_flag.update when row already exists", async () => {
    const state = makeState({
      flagRows: [{ key: "agent.x", enabled: false, scope_rule: null, description: "old", created_at: "", updated_at: "", updated_by: "" }],
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/feature-flags/agent.x",
      payload: { enabled: true, description: "updated" },
    });
    expect(resp.statusCode).toBe(200);
    expect(state.auditInserts[0].action).toBe("feature_flag.update");
  });
});

describe("DELETE /api/admin/feature-flags/:key", () => {
  it("returns deleted=false when row absent", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/feature-flags/missing",
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).deleted).toBe(false);
  });

  it("deletes and audits when row present", async () => {
    const state = makeState({
      flagRows: [{ key: "agent.x", enabled: true, scope_rule: null, description: "x", created_at: "", updated_at: "", updated_by: "" }],
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/feature-flags/agent.x",
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).deleted).toBe(true);
    expect(state.auditInserts[0].action).toBe("feature_flag.delete");
  });
});

describe("GET /api/admin/feature-flags", () => {
  it("403 for non-admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({ method: "GET", url: "/api/admin/feature-flags" });
    expect(resp.statusCode).toBe(403);
  });

  it("returns the catalog", async () => {
    const state = makeState({
      flagRows: [{ key: "agent.x", enabled: true, scope_rule: null, description: "x", created_at: "", updated_at: "", updated_by: "" }],
    });
    const app = await buildApp(state);
    const resp = await app.inject({ method: "GET", url: "/api/admin/feature-flags" });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.count).toBe(1);
    expect(body.flags[0].key).toBe("agent.x");
  });
});
