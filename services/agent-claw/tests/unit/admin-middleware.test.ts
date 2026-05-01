// Tests for services/agent-claw/src/middleware/require-admin.ts
//
// Phase 1 of the configuration concept.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Pool, QueryResult } from "pg";
import {
  isAdmin,
  requireAdmin,
  guardAdmin,
  AdminPermissionError,
} from "../../src/middleware/require-admin.js";

interface MockOpts {
  /** Result returned for the SELECT current_user_is_admin($1, $2) call. */
  isAdminResult: boolean;
  /** Capture the params passed to current_user_is_admin so tests can assert. */
  observedArgs?: { role: string | null; scope: string | null };
}

function makePool(opts: MockOpts): Pool {
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
          if (opts.observedArgs && params) {
            opts.observedArgs.role = params[0] as string | null;
            opts.observedArgs.scope = params[1] as string | null;
          }
          return {
            rows: [{ is_admin: opts.isAdminResult }] as unknown as T[],
            rowCount: 1,
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

describe("isAdmin (DB layer)", () => {
  const ORIGINAL_ENV = process.env.AGENT_ADMIN_USERS;
  beforeEach(() => {
    delete process.env.AGENT_ADMIN_USERS;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.AGENT_ADMIN_USERS;
    else process.env.AGENT_ADMIN_USERS = ORIGINAL_ENV;
  });

  it("returns true when DB function says yes", async () => {
    const pool = makePool({ isAdminResult: true });
    expect(await isAdmin(pool, "user@example.com")).toBe(true);
  });

  it("returns false when DB function says no and env is unset", async () => {
    const pool = makePool({ isAdminResult: false });
    expect(await isAdmin(pool, "user@example.com")).toBe(false);
  });

  it("returns false for empty user id without consulting the DB", async () => {
    // Pool throws if connect is called — so we know we short-circuited.
    const pool = {
      connect: async () => {
        throw new Error("pool.connect must not be called for empty user");
      },
    } as unknown as Pool;
    expect(await isAdmin(pool, "")).toBe(false);
  });

  it("passes role and scope to the DB function (NULL when scope=='')", async () => {
    const observed: { role: string | null; scope: string | null } = {
      role: null,
      scope: null,
    };
    const pool = makePool({ isAdminResult: true, observedArgs: observed });
    await isAdmin(pool, "u@x.com", "org_admin", "");
    expect(observed.role).toBe("org_admin");
    expect(observed.scope).toBe(null);
  });

  it("passes scope through verbatim when non-empty", async () => {
    const observed: { role: string | null; scope: string | null } = {
      role: null,
      scope: null,
    };
    const pool = makePool({ isAdminResult: true, observedArgs: observed });
    await isAdmin(pool, "u@x.com", "project_admin", "proj-42");
    expect(observed.role).toBe("project_admin");
    expect(observed.scope).toBe("proj-42");
  });
});

describe("isAdmin (env-var fallback)", () => {
  const ORIGINAL_ENV = process.env.AGENT_ADMIN_USERS;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.AGENT_ADMIN_USERS;
    else process.env.AGENT_ADMIN_USERS = ORIGINAL_ENV;
  });

  it("grants global_admin when env lists the user (case-insensitive)", async () => {
    process.env.AGENT_ADMIN_USERS = "Boss@Example.com, helper@x.com";
    const pool = makePool({ isAdminResult: false });
    expect(await isAdmin(pool, "boss@example.com")).toBe(true);
    expect(await isAdmin(pool, "BOSS@EXAMPLE.COM")).toBe(true);
  });

  it("does NOT grant scoped roles via env (only global_admin)", async () => {
    process.env.AGENT_ADMIN_USERS = "boss@example.com";
    const pool = makePool({ isAdminResult: false });
    expect(await isAdmin(pool, "boss@example.com", "org_admin", "acme")).toBe(false);
    expect(await isAdmin(pool, "boss@example.com", "project_admin", "p1")).toBe(false);
  });

  it("returns false when env is empty / whitespace-only", async () => {
    process.env.AGENT_ADMIN_USERS = "  ,  ";
    const pool = makePool({ isAdminResult: false });
    expect(await isAdmin(pool, "anyone@x.com")).toBe(false);
  });
});

describe("requireAdmin", () => {
  it("resolves to true when isAdmin returns true", async () => {
    const pool = makePool({ isAdminResult: true });
    await expect(requireAdmin(pool, "u@x.com")).resolves.toBe(true);
  });

  it("throws AdminPermissionError when not an admin", async () => {
    delete process.env.AGENT_ADMIN_USERS;
    const pool = makePool({ isAdminResult: false });
    await expect(requireAdmin(pool, "u@x.com")).rejects.toBeInstanceOf(AdminPermissionError);
  });

  it("error message mentions the requested role and scope", async () => {
    delete process.env.AGENT_ADMIN_USERS;
    const pool = makePool({ isAdminResult: false });
    try {
      await requireAdmin(pool, "u@x.com", "project_admin", "proj-7");
      expect.fail("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AdminPermissionError);
      const msg = (err as Error).message;
      expect(msg).toContain("project_admin");
      expect(msg).toContain("proj-7");
      expect((err as AdminPermissionError).statusCode).toBe(403);
    }
  });
});

describe("guardAdmin", () => {
  it("returns true and does not call reply when admin", async () => {
    const pool = makePool({ isAdminResult: true });
    const calls: { code: number; payload: unknown }[] = [];
    const reply = {
      status(code: number) {
        return {
          send(payload: unknown) {
            calls.push({ code, payload });
            return reply;
          },
        };
      },
    };
    expect(await guardAdmin(pool, "u@x.com", reply)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("returns false and sends 403 when not admin", async () => {
    delete process.env.AGENT_ADMIN_USERS;
    const pool = makePool({ isAdminResult: false });
    const calls: { code: number; payload: unknown }[] = [];
    const reply = {
      status(code: number) {
        return {
          send(payload: unknown) {
            calls.push({ code, payload });
            return reply;
          },
        };
      },
    };
    expect(await guardAdmin(pool, "u@x.com", reply)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe(403);
    const err = (calls[0].payload as { error: string }).error;
    expect(err).toMatch(/Permission denied/);
    expect(err).toMatch(/global_admin/);
  });
});
