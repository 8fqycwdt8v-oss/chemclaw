// Tests for the /api/admin/* skeleton router.
//
// Phase 1 of the configuration concept (Initiatives 2 + 10).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { Pool, QueryResult } from "pg";
import { registerAdminRoutes } from "../../src/routes/admin/index.js";

interface MockState {
  isAdminResult: boolean;
  insertedRoles: Array<{ user: string; role: string; scope: string; granter: string }>;
  deletedRoles: Array<{ user: string; role: string; scope: string }>;
  auditInserts: Array<{ actor: string; action: string; target: string }>;
  existingRoles: Array<{ user_entra_id: string; role: string; scope_id: string; granted_at: string; granted_by: string }>;
  auditRows: Array<{ id: string; occurred_at: string; actor: string; action: string; target: string; before_value: unknown; after_value: unknown; reason: string | null }>;
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
          return {
            rows: [{ is_admin: state.isAdminResult }] as unknown as T[],
            rowCount: 1,
            command: "SELECT",
            oid: 0,
            fields: [],
          };
        }
        if (sql.includes("INSERT INTO admin_roles")) {
          const [user, role, scope, granter] = params as string[];
          state.insertedRoles.push({ user, role, scope, granter });
          // Treat any first-time insert for (user,role,scope) as a real insert.
          const dup = state.existingRoles.some(
            (r) => r.user_entra_id === user && r.role === role && r.scope_id === scope,
          );
          if (dup) return { rows: [] as T[], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
          const inserted = {
            user_entra_id: user,
            role,
            scope_id: scope,
            granted_at: "2026-04-30T12:00:00Z",
            granted_by: granter,
          };
          state.existingRoles.push(inserted);
          return { rows: [inserted] as unknown as T[], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
        }
        if (sql.includes("DELETE FROM admin_roles")) {
          const [user, role, scope] = params as string[];
          const idx = state.existingRoles.findIndex(
            (r) => r.user_entra_id === user && r.role === role && r.scope_id === scope,
          );
          if (idx < 0) return { rows: [] as T[], rowCount: 0, command: "DELETE", oid: 0, fields: [] };
          const [removed] = state.existingRoles.splice(idx, 1);
          state.deletedRoles.push({ user, role, scope });
          return { rows: [removed] as unknown as T[], rowCount: 1, command: "DELETE", oid: 0, fields: [] };
        }
        if (sql.includes("FROM admin_roles") && sql.includes("WHERE user_entra_id")) {
          const [user] = params as string[];
          const rows = state.existingRoles.filter((r) => r.user_entra_id === user);
          return { rows: rows as unknown as T[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
        }
        if (sql.includes("INSERT INTO admin_audit_log")) {
          const [actor, action, target] = params as string[];
          state.auditInserts.push({ actor, action, target });
          return {
            rows: [{ id: `audit-${state.auditInserts.length}` }] as unknown as T[],
            rowCount: 1,
            command: "INSERT",
            oid: 0,
            fields: [],
          };
        }
        if (sql.includes("FROM admin_audit_log")) {
          return {
            rows: state.auditRows as unknown as T[],
            rowCount: state.auditRows.length,
            command: "SELECT",
            oid: 0,
            fields: [],
          };
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
    insertedRoles: [],
    deletedRoles: [],
    auditInserts: [],
    existingRoles: [],
    auditRows: [],
    ...overrides,
  };
}

async function buildApp(state: MockState, callerId = "admin@example.com") {
  const app = Fastify({ logger: false });
  const pool = makePool(state);
  registerAdminRoutes(app, pool, () => callerId);
  return await app;
}

const ORIGINAL_ENV = process.env.AGENT_ADMIN_USERS;
beforeEach(() => {
  delete process.env.AGENT_ADMIN_USERS;
});
afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.AGENT_ADMIN_USERS;
  else process.env.AGENT_ADMIN_USERS = ORIGINAL_ENV;
});

describe("POST /api/admin/users/:entra_id/admin-role", () => {
  it("403 when caller is not an admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/users/target@x.com/admin-role",
      payload: { role: "global_admin" },
    });
    expect(resp.statusCode).toBe(403);
    expect(state.insertedRoles).toHaveLength(0);
    expect(state.auditInserts).toHaveLength(0);
  });

  it("400 when global_admin is granted with non-empty scope_id", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/users/target@x.com/admin-role",
      payload: { role: "global_admin", scope_id: "acme" },
    });
    expect(resp.statusCode).toBe(400);
    expect(JSON.parse(resp.body).error).toMatch(/global_admin/);
  });

  it("400 when scoped role is granted without scope_id", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/users/target@x.com/admin-role",
      payload: { role: "org_admin" },
    });
    expect(resp.statusCode).toBe(400);
    expect(JSON.parse(resp.body).error).toMatch(/scope_id/);
  });

  it("inserts role + audit row on success and lower-cases the target", async () => {
    const state = makeState();
    const app = await buildApp(state, "boss@example.com");
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/users/Target@X.com/admin-role",
      payload: { role: "org_admin", scope_id: "acme", reason: "bootstrap" },
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.granted).toBe(true);
    expect(body.user_entra_id).toBe("target@x.com");
    expect(state.insertedRoles).toHaveLength(1);
    expect(state.insertedRoles[0]).toEqual({
      user: "target@x.com",
      role: "org_admin",
      scope: "acme",
      granter: "boss@example.com",
    });
    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0]).toEqual({
      actor: "boss@example.com",
      action: "admin_role.grant",
      target: "target@x.com",
    });
  });

  it("returns granted=false and skips audit when role already exists", async () => {
    const state = makeState({
      existingRoles: [
        {
          user_entra_id: "target@x.com",
          role: "global_admin",
          scope_id: "",
          granted_at: "2024-01-01T00:00:00Z",
          granted_by: "old-admin@x.com",
        },
      ],
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "POST",
      url: "/api/admin/users/target@x.com/admin-role",
      payload: { role: "global_admin" },
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).granted).toBe(false);
    expect(state.auditInserts).toHaveLength(0);
  });
});

describe("DELETE /api/admin/users/:entra_id/admin-role", () => {
  it("403 when caller is not an admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/target@x.com/admin-role?role=global_admin",
    });
    expect(resp.statusCode).toBe(403);
  });

  it("400 when query is invalid", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/target@x.com/admin-role?role=not_a_role",
    });
    expect(resp.statusCode).toBe(400);
  });

  it("revokes existing role and writes audit row", async () => {
    const state = makeState({
      existingRoles: [
        {
          user_entra_id: "target@x.com",
          role: "org_admin",
          scope_id: "acme",
          granted_at: "2024-01-01T00:00:00Z",
          granted_by: "boss@x.com",
        },
      ],
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/target@x.com/admin-role?role=org_admin&scope_id=acme",
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).revoked).toBe(true);
    expect(state.deletedRoles).toHaveLength(1);
    expect(state.auditInserts).toHaveLength(1);
    expect(state.auditInserts[0].action).toBe("admin_role.revoke");
  });

  it("returns revoked=false and skips audit when role does not exist", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "DELETE",
      url: "/api/admin/users/target@x.com/admin-role?role=global_admin",
    });
    expect(resp.statusCode).toBe(200);
    expect(JSON.parse(resp.body).revoked).toBe(false);
    expect(state.auditInserts).toHaveLength(0);
  });
});

describe("GET /api/admin/users/:entra_id/admin-roles", () => {
  it("403 when caller is not an admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "GET",
      url: "/api/admin/users/target@x.com/admin-roles",
    });
    expect(resp.statusCode).toBe(403);
  });

  it("returns all roles for a user", async () => {
    const state = makeState({
      existingRoles: [
        {
          user_entra_id: "target@x.com",
          role: "org_admin",
          scope_id: "acme",
          granted_at: "2024-01-01T00:00:00Z",
          granted_by: "boss@x.com",
        },
        {
          user_entra_id: "target@x.com",
          role: "project_admin",
          scope_id: "p-1",
          granted_at: "2024-02-01T00:00:00Z",
          granted_by: "boss@x.com",
        },
      ],
    });
    const app = await buildApp(state);
    const resp = await app.inject({
      method: "GET",
      url: "/api/admin/users/target@x.com/admin-roles",
    });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.user_entra_id).toBe("target@x.com");
    expect(body.roles).toHaveLength(2);
  });
});

describe("GET /api/admin/audit", () => {
  it("403 when caller is not an admin", async () => {
    const state = makeState({ isAdminResult: false });
    const app = await buildApp(state);
    const resp = await app.inject({ method: "GET", url: "/api/admin/audit" });
    expect(resp.statusCode).toBe(403);
  });

  it("400 when limit exceeds cap", async () => {
    const state = makeState();
    const app = await buildApp(state);
    const resp = await app.inject({ method: "GET", url: "/api/admin/audit?limit=10000" });
    expect(resp.statusCode).toBe(400);
  });

  it("returns the audit rows the mock pool exposes", async () => {
    const state = makeState({
      auditRows: [
        {
          id: "a1",
          occurred_at: "2026-04-01T00:00:00Z",
          actor: "boss@x.com",
          action: "admin_role.grant",
          target: "target@x.com",
          before_value: null,
          after_value: { role: "global_admin", scope_id: "" },
          reason: null,
        },
      ],
    });
    const app = await buildApp(state);
    const resp = await app.inject({ method: "GET", url: "/api/admin/audit" });
    expect(resp.statusCode).toBe(200);
    const body = JSON.parse(resp.body);
    expect(body.entries).toHaveLength(1);
    expect(body.count).toBe(1);
    expect(body.entries[0].action).toBe("admin_role.grant");
  });
});
