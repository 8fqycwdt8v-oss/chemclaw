// post_tool hook: redact-tool-output
//
// Defense-in-depth scrub of tool outputs before they enter the next-turn
// LLM context. Pre-fix only the OUTBOUND assistant text was redacted
// (post_turn `redact-secrets`); tool outputs (MCP-backed or builtin)
// flowed back to the model UNREDACTED, leaking SMILES / compound codes /
// NCE-IDs / emails embedded in free-text fields of tool responses.
//
// This hook walks every tool output (object / array / string) and applies
// the same length-bounded `redactString` primitive that the post_turn hook
// uses to scrub the assistant's reply, mutating string leaves in place.
//
// Ordering: this hook is registered at order 200 (see
// hooks/redact-tool-output.yaml) so it runs LAST in the post_tool phase.
// The earlier post_tool hooks (anti-fabrication, tag-maturity,
// source-cache, detect-mcp-leakage, fact-id-consistency-guard) all use
// the default order 100 and therefore see the UNREDACTED output for
// fact-ID harvesting / artifact stamping / source-cache writes /
// tripwire detection.
//
// Idempotent: `redactString` already replaces matches with the literal
// `[REDACTED]` (which is not itself a SMILES / NCE / CMP / email
// token), so re-running this hook on already-scrubbed output is a no-op.
//
// Why not active redaction in the LiteLLM egress callback?
// LiteLLM's pre-egress redactor (services/litellm_redactor/callback.py)
// scrubs prompts on their way TO the model — but the agent's CONVERSATION
// HISTORY (which becomes part of the next LiteLLM request) is assembled
// from tool outputs inside agent-claw BEFORE the egress redactor sees it.
// A hook here closes the loop: by the time agent-claw appends a tool
// result message to the messages array, it's already scrubbed.

import type { PostToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import { scrub } from "../../observability/redact-string.js";

// Source-system tool IDs that may carry PII / unredacted SMILES from external
// systems. Mirror the source-cache hook's regex (CLAUDE.md: post-tool source
// cache). Chemistry compute tools (canonicalize_smiles, find_similar_compounds,
// propose_retrosynthesis, recommend_next_batch, etc.) are EXCLUDED — the LLM
// must reason over their SMILES output to chain calls; redacting them would
// break the agent.
const SOURCE_SYSTEM_TOOL_RE = /^(query|fetch)_(eln|lims|instrument)_/;

/**
 * Walk an arbitrary JSON-shaped value and return a structurally identical
 * value where every string leaf has been passed through `scrub`. Mutation-
 * free for primitives that don't change; returns a new object/array only
 * when at least one leaf differs (cheap shallow-equality short-circuit).
 *
 * Numbers, booleans, null, undefined, and bigint pass through unchanged —
 * the redactor only matches string-shaped tokens.
 */
function scrubValue(value: unknown): unknown {
  if (typeof value === "string") {
    return scrub(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubValue(v);
    }
    return out;
  }
  return value;
}

/**
 * post_tool handler: scrubs every string leaf in `payload.output` in
 * place. Returns `{}` (no decision contribution to the lifecycle
 * aggregator — this hook is purely a mutator).
 *
 * Tolerates any output shape: object, array, string, primitive, null.
 */
export async function redactToolOutputHook(
  payload: PostToolPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  // Scope to source-system tool IDs only. Chemistry compute tools return
  // SMILES in structured fields and the LLM must reason over them to chain
  // calls — a blanket scrub would break canonicalize_smiles /
  // find_similar_compounds / propose_retrosynthesis / recommend_next_batch.
  // See BACKLOG.md line 208 (scoped scrubbing of mcp-eln-local / mcp-logs-sciy
  // payloads only).
  if (!SOURCE_SYSTEM_TOOL_RE.test(payload.toolId)) return {};
  payload.output = scrubValue(payload.output);
  return {};
}

/**
 * Register the redact-tool-output hook into a Lifecycle instance.
 *
 * Hook point: post_tool (defense-in-depth on tool outputs that flow into
 * the next-turn LLM context).
 */
export function registerRedactToolOutputHook(lifecycle: Lifecycle): void {
  lifecycle.on("post_tool", "redact-tool-output", redactToolOutputHook);
}
