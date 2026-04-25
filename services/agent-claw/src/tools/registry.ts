// In-memory ToolRegistry for Phase A.1.
// Phase A.2 will add DB-backed persistence (tools table from db/init/02_harness.sql).

import type { Tool } from "./tool.js";

export class ToolRegistry {
  private readonly _tools: Map<string, Tool> = new Map();

  /**
   * Register a tool. Throws if a tool with the same id is already registered
   * (prevents accidental double-registration silently overwriting a tool).
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
   * Register or replace a tool. Use this for hot-reload scenarios (tests,
   * skill loading). Prefer register() for static boot-time registration.
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

  /**
   * Resolve a tool by id. Returns undefined if not found.
   */
  get(id: string): Tool | undefined {
    return this._tools.get(id);
  }

  /**
   * Resolve a tool by id and throw if not found.
   * Used by the harness where a missing tool is a logic error.
   */
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
}
