// post_tool hook: anti-fabrication
//
// After every tool execution, scans the tool output for fact_id UUIDs and
// accumulates them into ctx.scratchpad.seenFactIds. This is the SOLE writer
// of the per-turn set; tools only READ it.
//
// Fact-id harvesting contract:
//   1. If the output has a `facts` array (query_kg output shape), each
//      element's `fact_id` field is added.
//   2. If the output has a `surfaced_fact_ids` array (expand_reaction_context,
//      check_contradictions output), every element is added.
//   3. If the output has a `contradictions` array, each item's `fact_ids`
//      array is added.
//   4. If the output has a top-level `fact_id` field (query_provenance, T3/H4),
//      that single fact_id is added — so the agent can investigate
//      provenance and then cite the fact.
//   5. If the output has an `items` array of discriminated-union members
//      with `kind: 'fact'` and a nested `fact.fact_id` (retrieve_related,
//      T3/H1), each fact_id is added.
//   6. No-op for tools that don't produce any of these shapes (canonicalize_smiles,
//      draft_section, etc.).
//
// The hook never throws — a harvesting failure must not abort the tool result.

import type { PostToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";

// UUID v4 pattern — used to extract bare UUIDs from generic string fields if needed.
const _UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function _isString(v: unknown): v is string {
  return typeof v === "string";
}

function _isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function _isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(_isString);
}

/**
 * Extract fact_ids from a structured tool output.
 * Returns an array of UUID strings to add to seenFactIds.
 */
export function extractFactIds(output: unknown): string[] {
  if (!_isRecord(output)) return [];

  const ids: string[] = [];

  // query_kg shape: { facts: [{ fact_id: "uuid", ... }, ...] }
  if (Array.isArray(output.facts)) {
    for (const fact of output.facts) {
      if (_isRecord(fact) && _isString(fact.fact_id)) {
        const m = fact.fact_id.match(_UUID_RE);
        if (m) ids.push(...m);
      }
    }
  }

  // expand_reaction_context / check_contradictions: { surfaced_fact_ids: ["uuid", ...] }
  if (_isStringArray(output.surfaced_fact_ids)) {
    ids.push(...output.surfaced_fact_ids);
  }

  // check_contradictions: { contradictions: [{ fact_ids: ["uuid", ...] }, ...] }
  if (Array.isArray(output.contradictions)) {
    for (const c of output.contradictions) {
      if (_isRecord(c) && _isStringArray(c.fact_ids)) {
        ids.push(...c.fact_ids);
      }
    }
  }

  // query_provenance shape (Tranche 3 / H4): top-level { fact_id: "uuid", ... }
  // The agent invokes this tool to investigate a fact's provenance; if the
  // fact_id weren't harvested here, a follow-up propose_hypothesis citing
  // that fact would trip the anti-fabrication HARD GUARD even though the
  // agent demonstrably saw the fact this turn.
  if (_isString(output.fact_id)) {
    const m = output.fact_id.match(_UUID_RE);
    if (m) ids.push(...m);
  }

  // retrieve_related shape (Tranche 3 / H1): { items: [{kind: 'fact', fact: {fact_id: ...}}, ...] }
  // Chunk items don't carry fact_ids; only fact items do.
  if (Array.isArray(output.items)) {
    for (const item of output.items) {
      if (
        _isRecord(item) &&
        item.kind === "fact" &&
        _isRecord(item.fact) &&
        _isString(item.fact.fact_id)
      ) {
        const m = item.fact.fact_id.match(_UUID_RE);
        if (m) ids.push(...m);
      }
    }
  }

  return ids;
}

/**
 * post_tool handler: harvest fact_ids from tool output → seenFactIds.
 */
export async function antiFabricationHook(
  payload: PostToolPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  try {
    const factIds = extractFactIds(payload.output);
    if (factIds.length === 0) return {};

    let seen = payload.ctx.scratchpad.get("seenFactIds") as Set<string> | undefined;
    if (!seen) {
      seen = new Set<string>();
      payload.ctx.scratchpad.set("seenFactIds", seen);
    }
    for (const id of factIds) {
      seen.add(id);
    }
  } catch {
    // Never crash on harvesting failure.
  }
  return {};
}

/**
 * Register the anti-fabrication hook into a Lifecycle instance.
 */
export function registerAntiFabricationHook(lifecycle: Lifecycle): void {
  lifecycle.on("post_tool", "anti-fabrication", antiFabricationHook);
}
