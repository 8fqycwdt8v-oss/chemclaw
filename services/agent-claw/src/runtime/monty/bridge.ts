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

import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Lifecycle } from "../../core/lifecycle.js";
import type { PermissionOptions, ToolContext } from "../../core/types.js";
import type { Tool } from "../../tools/tool.js";
import { runOneTool } from "../../core/run-one-tool.js";
import type { ExternalCallFrameT, ExternalResponseFrameT } from "./protocol.js";

const tracer = trace.getTracer("agent-claw.runtime.monty");

export interface BridgeRouteOptions {
  registry: { get(id: string): Tool | undefined };
  /** Tools the script is permitted to call this run. */
  allowedToolIds: ReadonlySet<string>;
  ctx: ToolContext;
  lifecycle: Lifecycle;
  /** PermissionOptions cloned from the outer call. */
  permissions?: PermissionOptions;
  /** Run id of the parent script — stamped on the per-call span so traces group cleanly. */
  parentRunId?: string;
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
  return await tracer.startActiveSpan("monty.external_call", async (span) => {
    // Canonical tool.* attributes (from CLAUDE.md "Harness primitives")
    // so Langfuse / OTLP filters that match `tool.id` find Monty's
    // external calls at the parent-span level too — without these,
    // dashboards have to special-case Monty traces. The Monty-specific
    // attributes (monty.external_call.* / monty.parent_run_id) remain so
    // operators can filter "code-mode only" runs.
    const tool = opts.registry.get(frame.name);
    span.setAttribute("tool.id", frame.name);
    span.setAttribute("tool.read_only", tool?.annotations?.readOnly ?? false);
    span.setAttribute("tool.in_batch", false);
    span.setAttribute("monty.external_call.tool_id", frame.name);
    span.setAttribute("monty.external_call.id", frame.id);
    if (opts.parentRunId) {
      span.setAttribute("monty.parent_run_id", opts.parentRunId);
      // monty.run_id mirrors the outer-tool-span attribute name so a
      // single trace query by run_id surfaces the parent script span +
      // every external_call span underneath it.
      span.setAttribute("monty.run_id", opts.parentRunId);
    }
    try {
      const result = await _routeExternalCall(frame, opts);
      span.setAttribute("monty.external_call.ok", result.trace.ok);
      span.setAttribute(
        "monty.external_call.duration_ms",
        result.trace.durationMs,
      );
      span.setAttribute("monty.outcome", result.trace.ok ? "ok" : "error");
      if (!result.trace.ok && result.trace.errorMessage) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: result.trace.errorMessage,
        });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      return result;
    } catch (err) {
      // Defense-in-depth: if anything between the registry lookup and
      // _routeExternalCall completion throws (registry get throwing,
      // lifecycle dispatch rejecting outside _routeExternalCall's own
      // try/catch, etc.), the host's outer catch translates it into a
      // clean error outcome — but the SPAN was previously closed with
      // no `monty.outcome` attribute, so post-mortem queries by run_id
      // missed the failure entirely. Stamp monty.outcome="error" before
      // rethrowing so the trace tree is complete.
      const message = err instanceof Error ? err.message : String(err);
      span.setAttribute("monty.outcome", "error");
      span.setAttribute("monty.external_call.ok", false);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw err;
    } finally {
      span.end();
    }
  });
}

async function _routeExternalCall(
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
