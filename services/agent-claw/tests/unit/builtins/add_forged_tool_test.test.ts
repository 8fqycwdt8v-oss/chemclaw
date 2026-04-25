// Tests for tools/builtins/add_forged_tool_test.ts — Phase D.5.

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import { buildAddForgedToolTestTool } from "../../../src/tools/builtins/add_forged_tool_test.js";
import { makeCtx } from "../../helpers/make-ctx.js";
import type { Pool } from "pg";

const ctx = makeCtx();

function makeMockPool(opts?: {
  ownerFound?: boolean;
  insertId?: string;
}): Pool {
  const insertId = opts?.insertId ?? randomUUID();
  const ownerFound = opts?.ownerFound ?? true;

  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql.includes("proposed_by_user_entra_id")) {
        // Ownership check.
        if (ownerFound) {
          return Promise.resolve({ rows: [{ id: "tool-id" }] });
        }
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes("INSERT INTO forged_tool_tests")) {
        return Promise.resolve({ rows: [{ id: insertId }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

describe("buildAddForgedToolTestTool — happy path", () => {
  it("inserts a functional test case and returns test_id", async () => {
    const expectedId = randomUUID();
    const pool = makeMockPool({ insertId: expectedId });
    const tool = buildAddForgedToolTestTool(pool, "user@test.com");

    const result = await tool.execute(ctx, {
      forged_tool_id: randomUUID(),
      input_json: { x: 1 },
      expected_output_json: { result: 2 },
      kind: "functional",
    });

    expect(result.test_id).toBe(expectedId);
    expect(result.kind).toBe("functional");
  });

  it("defaults kind to 'functional' when not specified (schema level)", () => {
    const pool = makeMockPool();
    const tool = buildAddForgedToolTestTool(pool, "user@test.com");

    // Zod applies the default at parse time; verify the schema default.
    const parsed = tool.inputSchema.safeParse({
      forged_tool_id: randomUUID(),
      input_json: { smiles: "CCO" },
      expected_output_json: { mw: 46.07 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("functional");
    }
  });

  it("accepts contract kind", async () => {
    const pool = makeMockPool();
    const tool = buildAddForgedToolTestTool(pool, "user@test.com");

    const result = await tool.execute(ctx, {
      forged_tool_id: randomUUID(),
      input_json: { x: 1 },
      expected_output_json: { result: 42 },
      kind: "contract",
    });

    expect(result.kind).toBe("contract");
  });

  it("accepts property kind", async () => {
    const pool = makeMockPool();
    const tool = buildAddForgedToolTestTool(pool, "user@test.com");

    const result = await tool.execute(ctx, {
      forged_tool_id: randomUUID(),
      input_json: { x: 0 },
      expected_output_json: { result: 0 },
      kind: "property",
    });

    expect(result.kind).toBe("property");
  });
});

describe("buildAddForgedToolTestTool — ownership gate", () => {
  it("throws when the caller does not own the tool", async () => {
    const pool = makeMockPool({ ownerFound: false });
    const tool = buildAddForgedToolTestTool(pool, "other@test.com");

    await expect(
      tool.execute(ctx, {
        forged_tool_id: randomUUID(),
        input_json: { x: 1 },
        expected_output_json: { result: 42 },
      }),
    ).rejects.toThrow(/not found or you are not the owner/);
  });
});

describe("buildAddForgedToolTestTool — schema validation", () => {
  it("rejects invalid UUID for forged_tool_id", () => {
    const pool = makeMockPool();
    const tool = buildAddForgedToolTestTool(pool, "user@test.com");
    const parsed = tool.inputSchema.safeParse({
      forged_tool_id: "not-a-uuid",
      input_json: {},
      expected_output_json: {},
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid kind", () => {
    const pool = makeMockPool();
    const tool = buildAddForgedToolTestTool(pool, "user@test.com");
    const parsed = tool.inputSchema.safeParse({
      forged_tool_id: randomUUID(),
      input_json: {},
      expected_output_json: {},
      kind: "banana",
    });
    expect(parsed.success).toBe(false);
  });
});
