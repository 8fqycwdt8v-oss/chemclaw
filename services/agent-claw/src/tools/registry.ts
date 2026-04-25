// In-memory ToolRegistry with DB-backed hydration.
//
// Phase A.1: in-memory register/deregister.
// Phase A.2: loadFromDb() reads `tools WHERE enabled=true`, builds Zod schemas
//            from schema_json, and registers each tool.
//            - source='builtin'  → looks up a hand-registered builtin factory
//            - source='mcp'      → builds an execute impl that POSTs to mcp_url+mcp_endpoint

import { z } from "zod";
import { type Pool } from "pg";
import { readFileSync } from "fs";
import type { Tool } from "./tool.js";
import { postJson } from "../mcp/postJson.js";
import type { SandboxClient } from "../core/sandbox.js";
import { wrapCode, parseOutputs, buildStubLibrary } from "./builtins/run_program.js";

// ---------------------------------------------------------------------------
// Zod-from-JSON schema builder.
// Supports: string, number, boolean, object (one level deep), array.
// ---------------------------------------------------------------------------

type JsonSchemaProperty = {
  type: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  required?: string[];
};

type JsonSchema = {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
};

function zodFromJsonSchema(schema: JsonSchema): z.ZodTypeAny {
  if (schema.type !== "object") {
    throw new Error(`Top-level schema must be 'object', got '${schema.type}'`);
  }
  return buildObjectSchema(schema);
}

function buildPropertySchema(prop: JsonSchemaProperty): z.ZodTypeAny {
  switch (prop.type) {
    case "string": {
      let s = z.string();
      if (prop.minLength !== undefined) s = s.min(prop.minLength);
      if (prop.maxLength !== undefined) s = s.max(prop.maxLength);
      return s;
    }
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "object":
      return buildObjectSchema(prop);
    case "array": {
      const itemSchema = prop.items
        ? buildPropertySchema(prop.items)
        : z.unknown();
      return z.array(itemSchema);
    }
    default:
      return z.unknown();
  }
}

function buildObjectSchema(
  schema: JsonSchemaProperty | JsonSchema,
): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  const required = new Set(schema.required ?? []);
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    let fieldSchema = buildPropertySchema(prop);
    if (!required.has(key)) {
      fieldSchema = fieldSchema.optional();
    }
    shape[key] = fieldSchema;
  }
  return z.object(shape);
}

// ---------------------------------------------------------------------------
// DB row shape returned by the tools query.
// ---------------------------------------------------------------------------

interface ToolRow {
  name: string;
  source: "builtin" | "mcp" | "skill" | "forged";
  schema_json: JsonSchema;
  mcp_url: string | null;
  mcp_endpoint: string | null;
  description: string;
  scripts_path?: string | null;
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private readonly _tools: Map<string, Tool> = new Map();

  // Map of builtin name → factory function.
  // Register factories here before calling loadFromDb() so that DB rows with
  // source='builtin' can find their implementation.
  private readonly _builtinFactories: Map<string, () => Tool> = new Map();

  // Sandbox client injected for source='forged' tool execution.
  // Set via setSandboxClient() before loadFromDb() if forged tools are in use.
  private _sandboxClient: SandboxClient | null = null;

  // In-process code cache for forged tools (read once per process startup).
  private readonly _forgedCodeCache: Map<string, string> = new Map();

  /**
   * Inject a SandboxClient so the registry can execute forged tools.
   * Must be called before loadFromDb() if the tools table contains source='forged' rows.
   */
  setSandboxClient(client: SandboxClient): this {
    this._sandboxClient = client;
    return this;
  }

  // ---------------------------------------------------------------------------
  // Static registration (Phase A.1 API — kept intact)
  // ---------------------------------------------------------------------------

  /**
   * Register a tool. Throws if a tool with the same id is already registered.
   */
  register(tool: Tool): this {
    if (this._tools.has(tool.id)) {
      throw new Error(
        `ToolRegistry: a tool with id "${tool.id}" is already registered.`,
      );
    }
    this._tools.set(tool.id, tool);
    return this;
  }

  /**
   * Register or replace a tool. Use for hot-reload / test scenarios.
   */
  upsert(tool: Tool): this {
    this._tools.set(tool.id, tool);
    return this;
  }

  /** Remove a tool by id. No-op if not present. */
  deregister(id: string): this {
    this._tools.delete(id);
    return this;
  }

  /** Resolve a tool by id. Returns undefined if not found. */
  get(id: string): Tool | undefined {
    return this._tools.get(id);
  }

  /** Resolve a tool by id; throw if not found. */
  getOrThrow(id: string): Tool {
    const tool = this._tools.get(id);
    if (!tool) {
      throw new Error(
        `ToolRegistry: tool "${id}" not found. Registered tools: [${[...this._tools.keys()].join(", ")}]`,
      );
    }
    return tool;
  }

  /** All registered tools as an array (for passing to LlmProvider). */
  all(): Tool[] {
    return [...this._tools.values()];
  }

  /** Number of registered tools. */
  get size(): number {
    return this._tools.size;
  }

  // ---------------------------------------------------------------------------
  // Builtin factory registry (Phase A.2)
  // ---------------------------------------------------------------------------

  /**
   * Register a factory function for a named builtin tool.
   * Call this before loadFromDb() so DB rows with source='builtin' can resolve.
   */
  registerBuiltin(name: string, factory: () => Tool): this {
    this._builtinFactories.set(name, factory);
    return this;
  }

  // ---------------------------------------------------------------------------
  // DB-backed hydration (Phase A.2)
  // ---------------------------------------------------------------------------

  /**
   * Read `tools WHERE enabled=true` from Postgres, build Zod schemas from
   * schema_json, and register each tool.
   *
   * - source='builtin': looks up the factory registered via registerBuiltin().
   * - source='mcp':     builds an execute impl that POSTs to mcp_url+mcp_endpoint.
   * - source='skill':   skipped (Phase B+).
   *
   * Idempotent: calling twice replaces existing registrations (uses upsert).
   */
  async loadFromDb(pool: Pool): Promise<void> {
    const { rows } = await pool.query<ToolRow>(
      `SELECT t.name, t.source, t.schema_json, t.mcp_url, t.mcp_endpoint, t.description,
              sl.scripts_path
         FROM tools t
         LEFT JOIN skill_library sl
               ON sl.name = t.name AND sl.kind = 'forged_tool'
        WHERE t.enabled = true
        ORDER BY t.name`,
    );

    for (const row of rows) {
      const tool = this._buildTool(row);
      if (tool) {
        this.upsert(tool);
      }
    }
  }

  private _buildTool(row: ToolRow): Tool | null {
    let inputSchema: z.ZodTypeAny;
    try {
      inputSchema = zodFromJsonSchema(row.schema_json);
    } catch {
      // Malformed schema_json — skip rather than crash.
      return null;
    }

    const outputSchema = z.unknown();

    if (row.source === "builtin") {
      const factory = this._builtinFactories.get(row.name);
      if (!factory) {
        // Builtin factory not registered — skip.
        return null;
      }
      const impl = factory();
      // Use the DB description but preserve the impl's execute + output schema.
      return {
        ...impl,
        description: row.description,
        inputSchema,
      };
    }

    if (row.source === "mcp") {
      if (!row.mcp_url || !row.mcp_endpoint) {
        return null;
      }
      const url = `${row.mcp_url.replace(/\/$/, "")}${row.mcp_endpoint}`;
      const name = row.name;

      return {
        id: name,
        description: row.description,
        inputSchema,
        outputSchema,
        execute: async (_ctx, input) => {
          return postJson(url, input, outputSchema, 15_000, name);
        },
      };
    }

    // source='forged' -- execute via E2B sandbox using the stored Python code.
    if (row.source === "forged") {
      if (!row.scripts_path) {
        // No scripts_path — cannot execute; skip.
        return null;
      }
      if (!this._sandboxClient) {
        // SandboxClient not injected — log and skip.
        // eslint-disable-next-line no-console
        console.warn(
          `ToolRegistry: skipping forged tool '${row.name}' — setSandboxClient() was not called.`,
        );
        return null;
      }

      const sandboxClient = this._sandboxClient;
      const scriptsPath = row.scripts_path;
      const name = row.name;
      const codeCache = this._forgedCodeCache;

      // Build the stub library using default localhost URLs
      // (registry does not have DB access at call time; caller can inject URLs).
      const defaultStub = buildStubLibrary({});

      return {
        id: name,
        description: row.description,
        inputSchema,
        outputSchema,
        execute: async (_ctx, input) => {
          // Load code from disk on first call (cached in memory thereafter).
          let code = codeCache.get(name);
          if (!code) {
            try {
              code = readFileSync(scriptsPath, "utf-8");
              codeCache.set(name, code);
            } catch (err) {
              throw new Error(
                `ToolRegistry: failed to read forged tool code from '${scriptsPath}': ${(err as Error).message}`,
              );
            }
          }

          const inputRecord = input as Record<string, unknown>;
          const expectedOutputs = Object.keys(
            (row.schema_json as Record<string, unknown>)["properties"] ?? {},
          );

          const handle = await sandboxClient.createSandbox();
          try {
            // Mount stub.
            await sandboxClient.mountReadOnlyFile(
              handle,
              Buffer.from(defaultStub, "utf-8"),
              "/sandbox/chemclaw/__init__.py",
            );

            const wrappedCode = wrapCode(code, inputRecord, expectedOutputs);
            const result = await sandboxClient.executePython(handle, wrappedCode, {});

            if (result.exit_code !== 0) {
              throw new Error(
                `forged tool '${name}' exited ${result.exit_code}: ${result.stderr.slice(0, 500)}`,
              );
            }

            return parseOutputs(result.stdout) ?? {};
          } finally {
            await sandboxClient.closeSandbox(handle);
          }
        },
      };
    }

    // source='skill' -- deferred to Phase B.
    return null;
  }
}
