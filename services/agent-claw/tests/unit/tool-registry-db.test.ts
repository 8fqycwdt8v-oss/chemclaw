// Tests for ToolRegistry.loadFromDb():
//   - builtin source: calls the registered factory + uses the DB description
//   - mcp source: execute() POSTs to the right URL
//   - skill source: skipped (no-op in Phase A.2)
//   - malformed schema_json: skipped gracefully

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolRegistry } from "../../src/tools/registry.js";
import { defineTool } from "../../src/tools/tool.js";
import { z } from "zod";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildFakePool(rows: object[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as Pool;
}

const echoBuiltin = defineTool({
  id: "echo_tool",
  description: "Echo stub",
  inputSchema: z.object({ msg: z.string() }),
  outputSchema: z.object({ out: z.string() }),
  execute: async (_ctx, { msg }) => ({ out: msg }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolRegistry.loadFromDb()", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("registers a builtin tool from DB row using the factory", async () => {
    registry.registerBuiltin("echo_tool", () => echoBuiltin);

    const pool = buildFakePool([
      {
        name: "echo_tool",
        source: "builtin",
        schema_json: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        mcp_url: null,
        mcp_endpoint: null,
        description: "DB description for echo",
        enabled: true,
      },
    ]);

    await registry.loadFromDb(pool);

    expect(registry.size).toBe(1);
    const tool = registry.getOrThrow("echo_tool");
    expect(tool.description).toBe("DB description for echo");
  });

  it("builtin tool's execute calls through to the factory impl", async () => {
    const executeSpy = vi.fn().mockResolvedValue({ out: "hello" });
    const spiedTool = { ...echoBuiltin, execute: executeSpy };
    registry.registerBuiltin("echo_tool", () => spiedTool);

    const pool = buildFakePool([
      {
        name: "echo_tool",
        source: "builtin",
        schema_json: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        mcp_url: null,
        mcp_endpoint: null,
        description: "Echo via builtin",
        enabled: true,
      },
    ]);

    await registry.loadFromDb(pool);
    const tool = registry.getOrThrow("echo_tool");
    const seenFactIds = new Set<string>();
    const ctx = { userEntraId: "test", scratchpad: new Map<string, unknown>([["seenFactIds", seenFactIds]]), seenFactIds };
    await tool.execute(ctx, { msg: "hello" });

    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it("registers an MCP-source tool that POSTs to the right URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ canonical_smiles: "c1ccccc1" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const pool = buildFakePool([
      {
        name: "canonicalize_smiles",
        source: "mcp",
        schema_json: {
          type: "object",
          properties: {
            smiles: { type: "string" },
          },
          required: ["smiles"],
        },
        mcp_url: "http://mcp-rdkit:8001",
        mcp_endpoint: "/tools/canonicalize_smiles",
        description: "MCP canonicalize",
        enabled: true,
      },
    ]);

    await registry.loadFromDb(pool);
    const tool = registry.getOrThrow("canonicalize_smiles");
    const seenFactIds = new Set<string>();
    const ctx = { userEntraId: "test", scratchpad: new Map<string, unknown>([["seenFactIds", seenFactIds]]), seenFactIds };

    await tool.execute(ctx, { smiles: "c1ccccc1" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(calledUrl).toBe("http://mcp-rdkit:8001/tools/canonicalize_smiles");

    vi.unstubAllGlobals();
  });

  it("skips skill-source tools (Phase B+ only)", async () => {
    const pool = buildFakePool([
      {
        name: "some_skill",
        source: "skill",
        schema_json: { type: "object", properties: {} },
        mcp_url: null,
        mcp_endpoint: null,
        description: "A skill tool",
        enabled: true,
      },
    ]);

    await registry.loadFromDb(pool);
    expect(registry.size).toBe(0);
  });

  it("skips builtin row when no factory is registered for the name", async () => {
    // No registerBuiltin() call — factory map is empty.
    const pool = buildFakePool([
      {
        name: "unknown_builtin",
        source: "builtin",
        schema_json: { type: "object", properties: {} },
        mcp_url: null,
        mcp_endpoint: null,
        description: "Unknown",
        enabled: true,
      },
    ]);

    await registry.loadFromDb(pool);
    expect(registry.size).toBe(0);
  });

  it("skips MCP tool row when mcp_url or mcp_endpoint is null", async () => {
    const pool = buildFakePool([
      {
        name: "broken_mcp",
        source: "mcp",
        schema_json: { type: "object", properties: {} },
        mcp_url: null,
        mcp_endpoint: null,
        description: "Broken MCP row",
        enabled: true,
      },
    ]);

    await registry.loadFromDb(pool);
    expect(registry.size).toBe(0);
  });

  it("registers multiple tools from a single loadFromDb call", async () => {
    const echoFactory = vi.fn().mockReturnValue(echoBuiltin);
    registry.registerBuiltin("echo_tool", echoFactory);

    const pool = buildFakePool([
      {
        name: "echo_tool",
        source: "builtin",
        schema_json: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        mcp_url: null,
        mcp_endpoint: null,
        description: "Echo",
        enabled: true,
      },
      {
        name: "mcp_tool_1",
        source: "mcp",
        schema_json: {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        },
        mcp_url: "http://svc:9000",
        mcp_endpoint: "/run",
        description: "An MCP tool",
        enabled: true,
      },
    ]);

    await registry.loadFromDb(pool);
    expect(registry.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// zodFromJsonSchema coverage — db/seed/05_harness_tools.sql carries 41+ rows
// using `type:"integer"` / `enum` / `minimum`/`maximum` / `format` / `pattern`
// / `additionalProperties`. Pre-PR these silently fell through to z.unknown(),
// so agent-side validation was weaker than the catalog claimed.
// ---------------------------------------------------------------------------

describe("ToolRegistry.loadFromDb() — zodFromJsonSchema schema features", () => {
  let registry: ToolRegistry;
  beforeEach(() => {
    registry = new ToolRegistry();
  });

  function loadWith(schema: object): Promise<void> {
    registry.registerBuiltin("schema_tool", () => ({
      ...echoBuiltin,
      id: "schema_tool",
      execute: async () => ({ out: "ok" }),
    }));
    const pool = buildFakePool([
      {
        name: "schema_tool",
        source: "builtin",
        schema_json: schema,
        mcp_url: null,
        mcp_endpoint: null,
        description: "Schema feature test",
        enabled: true,
      },
    ]);
    return registry.loadFromDb(pool);
  }

  it("rejects non-integer values for type:'integer'", async () => {
    await loadWith({
      type: "object",
      properties: { count: { type: "integer" } },
      required: ["count"],
    });
    const tool = registry.getOrThrow("schema_tool");
    expect(tool.inputSchema.safeParse({ count: 3 }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ count: 3.5 }).success).toBe(false);
  });

  it("enforces integer minimum/maximum bounds", async () => {
    await loadWith({
      type: "object",
      properties: { n: { type: "integer", minimum: 1, maximum: 100 } },
      required: ["n"],
    });
    const tool = registry.getOrThrow("schema_tool");
    expect(tool.inputSchema.safeParse({ n: 50 }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ n: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ n: 101 }).success).toBe(false);
  });

  it("enforces number minimum/maximum bounds", async () => {
    await loadWith({
      type: "object",
      properties: { temp: { type: "number", minimum: -273.15, maximum: 1000 } },
      required: ["temp"],
    });
    const tool = registry.getOrThrow("schema_tool");
    expect(tool.inputSchema.safeParse({ temp: 25 }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ temp: -300 }).success).toBe(false);
  });

  it("enforces string enum", async () => {
    await loadWith({
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow", "auto"] } },
      required: ["mode"],
    });
    const tool = registry.getOrThrow("schema_tool");
    expect(tool.inputSchema.safeParse({ mode: "fast" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ mode: "wrong" }).success).toBe(false);
  });

  it("enforces string pattern (regex)", async () => {
    await loadWith({
      type: "object",
      properties: { id: { type: "string", pattern: "^[A-Z]{2}-[0-9]{4}$" } },
      required: ["id"],
    });
    const tool = registry.getOrThrow("schema_tool");
    expect(tool.inputSchema.safeParse({ id: "AB-1234" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ id: "ab-1234" }).success).toBe(false);
  });

  it("enforces string format=uuid", async () => {
    await loadWith({
      type: "object",
      properties: { ref: { type: "string", format: "uuid" } },
      required: ["ref"],
    });
    const tool = registry.getOrThrow("schema_tool");
    expect(tool.inputSchema.safeParse({ ref: "550e8400-e29b-41d4-a716-446655440000" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ ref: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects extra properties when additionalProperties:false", async () => {
    await loadWith({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
    const tool = registry.getOrThrow("schema_tool");
    expect(tool.inputSchema.safeParse({ a: "x" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ a: "x", surprise: 1 }).success).toBe(false);
  });

  it("permits extra properties by default (additionalProperties unset)", async () => {
    await loadWith({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    const tool = registry.getOrThrow("schema_tool");
    expect(tool.inputSchema.safeParse({ a: "x", extra: true }).success).toBe(true);
  });
});
