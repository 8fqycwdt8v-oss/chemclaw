// services/agent-claw/src/core/hooks/conclusion-buffer.ts
//
// post_tool hook: kg-conclusion-buffer (Phase 6 — Universal Knowledge Accumulation)
//
// Accumulates chemistry-relevant tool outputs in ctx.scratchpad under the key
// "kg_conclusion_inputs" so the companion post_turn hook (kg-conclusion-extractor)
// can extract ABSTRACTED facts from the full turn's tool evidence.
//
// Only buffers non-internal tools whose output is a non-empty object/array —
// ignores side-effect tools (manage_todos, ask_user, …) and tools that return
// null / empty / error strings. The buffer entry shape mirrors what the
// extractor prompt expects.
//
// The scratchpad is a per-turn Map<string, unknown> that the init-scratch
// pre_turn hook initialises to empty at the start of every turn.
// "kg_conclusion_inputs" is always an array in this hook; the extractor reads
// it as-is and clears it after the LLM call.
//
// Feature-gated by `kg.conclusion_extraction.enabled` (default false). The
// YAML condition block also gates REGISTRATION, so an admin can enable it
// without a code deploy.

import type { Lifecycle } from "../lifecycle.js";
import type { PostToolPayload } from "../types.js";
import type { HookJSONOutput } from "../hook-output.js";
import { getLogger } from "../../observability/logger.js";

const SCRATCHPAD_KEY = "kg_conclusion_inputs";

// Chemistry tools whose outputs carry science-grade claims. Internal builtins
// (manage_todos, ask_user, …) are excluded via the is_internal flag but we
// also skip source-fetch and ingestion tools that produce row-dumps rather
// than analytical claims.
const CHEMISTRY_TOOL_PATTERN =
  /^(propose_retrosynthesis|predict_yield|predict_molecular_property|elucidate_mechanism|qm_single_point|qm_crest_screen|assess_applicability_domain|identify_unknown_from_ms|statistical_analyze|generate_focused_library|screen_compounds|score_route|optimize_conditions|analyze_chromatogram|interpret_nmr|interpret_ms)/;

export interface KgConclusionInput {
  toolId: string;
  input: unknown;
  output: unknown;
}

export function registerConclusionBufferHook(lifecycle: Lifecycle): void {
  const log = getLogger("kg-conclusion-buffer");

  lifecycle.on("post_tool", "kg-conclusion-buffer", async (payload: PostToolPayload): Promise<HookJSONOutput> => {
    try {
      const { ctx, toolId, input, output } = payload;

      // Skip internal tools and non-chemistry tools.
      if (!CHEMISTRY_TOOL_PATTERN.test(toolId)) return {};

      // Skip empty / null / error-string outputs that carry no facts.
      if (output === null || output === undefined) return {};
      if (typeof output === "string") return {};
      if (Array.isArray(output) && output.length === 0) return {};
      if (typeof output === "object" && !Array.isArray(output) && Object.keys(output).length === 0) return {};

      const existing = ctx.scratchpad.get(SCRATCHPAD_KEY);
      const buf: KgConclusionInput[] = Array.isArray(existing) ? (existing as KgConclusionInput[]) : [];
      buf.push({ toolId, input, output });
      ctx.scratchpad.set(SCRATCHPAD_KEY, buf);

      log.debug({ toolId, bufLen: buf.length }, "kg-conclusion-buffer: buffered tool output");
    } catch (err) {
      log.warn({ err }, "kg-conclusion-buffer: unexpected error (swallowed)");
    }
    return {};
  });
}
