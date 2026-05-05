// External-function bridge for the Monty orchestration runtime.
//
// When a script running inside Monty calls `external_function("foo", {...})`,
// the child sends an ExternalCallFrame to the host. This module turns that
// frame into a `runOneTool` call so each external_function inherits the full
// permission / pre_tool / withToolSpan / post_tool / post_tool_failure
// pipeline the harness uses for any other tool.
//
// Critical invariants:
//   1. Every external call goes through `runOneTool`. We never bypass the
//      permission resolver, never call withSystemContext to escape RLS,
//      never short-circuit pre_tool. The script gets exactly the same
//      surface as if the LLM had emitted the same tool_call directly.
//   2. The bridge runs in the parent process, inside the AsyncLocalStorage
//      RequestContext established by the route. `postJson` / `getJson` /
//      `withUserContext` see the same userEntraId and JWT they would for
//      a top-level tool call.
//   3. Calls outside the `allowed_tools` allow-list are rejected before the
//      resolver runs — the script can request a tool, but the host treats
//      "not in allow-list" as a deny. This is the script's chance to
//      enumerate the tools it intends to use; the LLM can read the deny
//      message and adjust the next script.

import type { Lifecycle } from "../../core/lifecycle.js";
import type { PermissionOptions, ToolContext } from "../../core/types.js";
import type { Tool } from "../../tools/tool.js";
import { runOneTool } from "../../core/run-one-tool.js";
import type { ExternalCallFrameT, ExternalResponseFrameT } from "./protocol.js";

export interface BridgeRouteOptions {
  registry: { get(id: string): Tool | undefined };
  /** Tools the script is permitted to call this run. */
  allowedToolIds: ReadonlySet<string>;
  ctx: ToolContext;
  lifecycle: Lifecycle;
  /** PermissionOptions cloned from the outer call. */
  permissions?: PermissionOptions;
}

export interface BridgeCallTrace {
  toolId: string;
  durationMs: number;
  ok: boolean;
  errorMessage?: string;
}

/**
 * Translate one external_function call into a runOneTool dispatch.
 * Returns the response frame the host should hand back to the child plus a
 * compact trace entry so the host can roll the calls up into the script's
 * outer tool result.
 *
 * Errors are caught and translated into `ok: false` responses so a single
 * tool failure doesn't kill the script — the script can `try`/`except`
 * around external_function and decide what to do.
 */
export async function routeExternalCall(
  frame: ExternalCallFrameT,
  opts: BridgeRouteOptions,
): Promise<{ response: ExternalResponseFrameT; trace: BridgeCallTrace }> {
  const { registry, allowedToolIds, ctx, lifecycle, permissions } = opts;
  const { id, name, args } = frame;
  const startedAt = Date.now();

  if (!allowedToolIds.has(name)) {
    const message = `tool '${name}' not in allowed_tools allow-list`;
    return {
      response: { type: "external_response", id, ok: false, error: message },
      trace: {
        toolId: name,
        durationMs: Date.now() - startedAt,
        ok: false,
        errorMessage: message,
      },
    };
  }

  const tool = registry.get(name);
  if (!tool) {
    const message = `tool '${name}' not registered`;
    return {
      response: { type: "external_response", id, ok: false, error: message },
      trace: {
        toolId: name,
        durationMs: Date.now() - startedAt,
        ok: false,
        errorMessage: message,
      },
    };
  }

  // runOneTool wants a tools[] for resolution; pass exactly the one tool
  // we just looked up so the inner search short-circuits and the registry
  // contract (id matches an entry) holds.
  try {
    const result = await runOneTool({
      tools: [tool],
      toolId: name,
      input: args,
      lifecycle,
      ctx,
      permissions,
    });
    // runOneTool returns a synthetic deny payload (object with `error`
    // field) on permission deny; preserve that shape so the script sees
    // the structured deny and the trace records ok=false.
    const denied =
      result.output &&
      typeof result.output === "object" &&
      "error" in (result.output as Record<string, unknown>) &&
      typeof (result.output as Record<string, unknown>).error === "string" &&
      ((result.output as Record<string, unknown>).error as string).startsWith(
        "denied_by_",
      );
    return {
      response: { type: "external_response", id, ok: !denied, value: result.output },
      trace: {
        toolId: name,
        durationMs: Date.now() - startedAt,
        ok: !denied,
        errorMessage: denied
          ? ((result.output as Record<string, unknown>).error as string)
          : undefined,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      response: { type: "external_response", id, ok: false, error: message },
      trace: {
        toolId: name,
        durationMs: Date.now() - startedAt,
        ok: false,
        errorMessage: message,
      },
    };
  }
}
