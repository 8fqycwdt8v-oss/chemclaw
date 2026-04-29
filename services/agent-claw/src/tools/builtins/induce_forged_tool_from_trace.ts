// induce_forged_tool_from_trace — Phase D.5.
//
// Reads a Langfuse trace, extracts the tool-call sequence, asks the LLM
// (planner role) to generalize it into a single Python function with declared
// input/output schemas and ≥3 test cases, then delegates to forge_tool's
// 4-stage Forjador validate pipeline.
//
// Langfuse trace API is mocked in tests (see ALLOWED_COMPROMISES in AGENTS.md).
// In production, set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY + LANGFUSE_HOST.

import { z } from "zod";
import { defineTool } from "../tool.js";
import type { LlmProvider } from "../../llm/provider.js";
import type { SandboxClient } from "../../core/sandbox.js";
import type { Pool } from "pg";
import {
  buildForgeToolTool,
  validateJsonSchema,
} from "./forge_tool.js";

// ---------------------------------------------------------------------------
// Langfuse trace client (thin wrapper; mocked in tests).
// ---------------------------------------------------------------------------

export interface LangfuseTraceEvent {
  tool_id: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  timestamp: string;
}

export interface LangfuseTrace {
  id: string;
  tool_events: LangfuseTraceEvent[];
}

export type LangfuseTraceReader = (traceId: string) => Promise<LangfuseTrace>;

/** Production implementation — reads from Langfuse REST API. */
export function makeLangfuseTraceReader(): LangfuseTraceReader {
  return async (traceId: string): Promise<LangfuseTrace> => {
    const host = process.env.LANGFUSE_HOST ?? "http://localhost:3000";
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? "";
    const secretKey = process.env.LANGFUSE_SECRET_KEY ?? "";

    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
    const url = `${host}/api/public/traces/${encodeURIComponent(traceId)}`;

    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      throw new Error(
        `induce_forged_tool_from_trace: Langfuse trace API returned ${res.status} for trace ${traceId}`,
      );
    }

    const body = (await res.json()) as Record<string, unknown>;

    // Extract tool-call observations from the Langfuse trace JSON.
    const observations = (body.observations ?? []) as Array<Record<string, unknown>>;
    const toolEvents: LangfuseTraceEvent[] = [];

    for (const obs of observations) {
      if (obs.type === "SPAN" && obs.name && String(obs.name).startsWith("tool:")) {
        const toolId = String(obs.name).replace(/^tool:/, "");
        const input = (obs.input as Record<string, unknown>) ?? {};
        const output = (obs.output as Record<string, unknown>) ?? {};
        const timestamp = String(obs.startTime ?? "");
        toolEvents.push({ tool_id: toolId, input, output, timestamp });
      }
    }

    return { id: traceId, tool_events: toolEvents };
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const InduceFromTraceIn = z.object({
  trace_id: z
    .string()
    .min(1)
    .max(200)
    .describe("Langfuse trace ID to read."),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "name must be a lowercase slug"),
  description: z.string().min(1).max(2000),
});
export type InduceFromTraceInput = z.infer<typeof InduceFromTraceIn>;

export const InduceFromTraceOut = z.object({
  trace_id: z.string(),
  tool_events_found: z.number().int(),
  forge_result: z.unknown(),
});
export type InduceFromTraceOutput = z.infer<typeof InduceFromTraceOut>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildInduceForgedToolFromTraceTool(
  pool: Pool,
  sandboxClient: SandboxClient,
  llm: LlmProvider,
  forgedToolsDir: string,
  userEntraId: string,
  traceReader?: LangfuseTraceReader,
) {
  const reader = traceReader ?? makeLangfuseTraceReader();

  return defineTool({
    id: "induce_forged_tool_from_trace",
    description:
      "Read a Langfuse trace, extract the tool-call sequence, and ask the planner " +
      "to generalize it into a reusable Python tool. Runs the full 4-stage Forjador validate. " +
      "Provide the trace_id, a unique tool name (slug), and a description.",
    inputSchema: InduceFromTraceIn,
    outputSchema: InduceFromTraceOut,

    execute: async (ctx, input) => {
      // Step 1: read the trace.
      const trace = await reader(input.trace_id);

      if (trace.tool_events.length === 0) {
        throw new Error(
          `induce_forged_tool_from_trace: no tool-call events found in trace '${input.trace_id}'.`,
        );
      }

      // Step 2: ask planner to generalize the trajectory into a tool spec.
      const system = `You are an expert Python programmer and agent architect.
Given a sequence of tool-call events from an agent trace, generalize the pattern into
a single reusable Python tool with: input JSON Schema, output JSON Schema, and at least
3 representative test cases derived from the actual trace inputs/outputs.

Return a JSON object with keys:
  "input_schema_json": object (JSON Schema, type=object)
  "output_schema_json": object (JSON Schema, type=object)
  "test_cases": array of {input: object, expected_output: object} (min 3)
  "implementation_hint": string (optional, max 500 chars)
  "python_code": string (complete Python implementation)`;

      const user = `Tool name to create: ${input.name}
Description: ${input.description}

Tool-call sequence from trace (${trace.tool_events.length} events):
${trace.tool_events
  .map(
    (e, i) =>
      `[${i}] tool=${e.tool_id}\n    input=${JSON.stringify(e.input)}\n    output=${JSON.stringify(e.output)}`,
  )
  .join("\n")}

Generalize this sequence into a single reusable Python tool.`;

      const raw = (await llm.completeJson({ system, user, role: "planner" })) as Record<
        string,
        unknown
      >;

      // Validate the response contains required keys.
      if (!raw.input_schema_json || !raw.output_schema_json) {
        throw new Error(
          "induce_forged_tool_from_trace: LLM did not return input_schema_json or output_schema_json.",
        );
      }
      if (!Array.isArray(raw.test_cases) || (raw.test_cases as unknown[]).length < 2) {
        throw new Error(
          "induce_forged_tool_from_trace: LLM must return at least 2 test_cases.",
        );
      }

      try {
        validateJsonSchema(raw.input_schema_json as Record<string, unknown>);
        validateJsonSchema(raw.output_schema_json as Record<string, unknown>);
      } catch (err) {
        throw new Error(
          `induce_forged_tool_from_trace: schema validation failed: ${(err as Error).message}`,
        );
      }

      // Step 3: delegate to forge_tool.
      const forgeTool = buildForgeToolTool(
        pool,
        sandboxClient,
        llm,
        forgedToolsDir,
        userEntraId,
        undefined, // forgedByModel
        "planner", // forgedByRole — induced tools are planner-level
      );

      const testCases = (raw.test_cases as Array<{ input: unknown; expected_output: unknown }>).map(
        (tc) => ({
          input: tc.input as Record<string, unknown>,
          expected_output: tc.expected_output as Record<string, unknown>,
        }),
      );

      const forgeResult = await forgeTool.execute(ctx, {
        name: input.name,
        description: input.description,
        input_schema_json: raw.input_schema_json as Record<string, unknown>,
        output_schema_json: raw.output_schema_json as Record<string, unknown>,
        test_cases: testCases.slice(0, 10), // max 10 per forge_tool schema
        implementation_hint: typeof raw.implementation_hint === "string"
          ? raw.implementation_hint
          : undefined,
      });

      return {
        trace_id: input.trace_id,
        tool_events_found: trace.tool_events.length,
        forge_result: forgeResult,
      };
    },
  });
}
