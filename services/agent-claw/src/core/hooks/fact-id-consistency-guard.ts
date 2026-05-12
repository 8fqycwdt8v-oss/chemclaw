// post_tool hook: fact-id consistency guard
//
// Validates that every fact_id appearing in a tool output's
// `surfaced_fact_ids[]` declaration is also present in the same output's
// concrete fact-bearing fields (`facts[]`, `items[]` of kind 'fact', or
// `contradictions[].fact_ids[]`). A mismatch suggests the tool wrapper
// fabricated the declaration — most commonly via a forged tool returning
// a hallucinated summary, a corrupted upstream payload, or a buggy
// post-processing layer that drops items but forgets to update the
// declaration array.
//
// Action on mismatch: structured-log warning. The hook never throws or
// denies — by design, this is the cheap, low-risk start recommended by
// the 2026-05-10 review §2.6. A future iteration may add a denying
// variant gated on a feature flag.

import type { PostToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import type { HookJSONOutput } from "../hook-output.js";
import { getLogger } from "../../observability/logger.js";

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
 * Walk a tool output and collect every fact_id that the output actually
 * carries (as opposed to declares). Mirrors the harvesting paths in
 * anti-fabrication.ts so the two hooks agree on what counts as
 * "actually surfaced".
 */
export function collectActualFactIds(output: unknown): Set<string> {
  const ids = new Set<string>();
  if (!_isRecord(output)) return ids;

  if (Array.isArray(output.facts)) {
    for (const f of output.facts) {
      if (_isRecord(f) && _isString(f.fact_id)) ids.add(f.fact_id);
    }
  }
  if (Array.isArray(output.items)) {
    for (const item of output.items) {
      if (
        _isRecord(item) &&
        item.kind === "fact" &&
        _isRecord(item.fact) &&
        _isString(item.fact.fact_id)
      ) {
        ids.add(item.fact.fact_id);
      }
    }
  }
  if (Array.isArray(output.contradictions)) {
    for (const c of output.contradictions) {
      if (_isRecord(c) && _isStringArray(c.fact_ids)) {
        for (const id of c.fact_ids) ids.add(id);
      }
    }
  }
  if (_isString(output.fact_id)) {
    ids.add(output.fact_id);
  }
  return ids;
}

/** True iff the output declares surfaced_fact_ids and any entry is missing
 *  from the actual fact_id set. Pure for unit-testing. */
export function findMissingFactIds(output: unknown): string[] {
  if (!_isRecord(output)) return [];
  const declared = output.surfaced_fact_ids;
  if (!_isStringArray(declared) || declared.length === 0) return [];
  const actual = collectActualFactIds(output);
  return declared.filter((id) => !actual.has(id));
}

export async function factIdConsistencyGuardHook(
  payload: PostToolPayload,
  _toolUseID?: string,
  _options?: { signal: AbortSignal },
): Promise<HookJSONOutput> {
  try {
    const missing = findMissingFactIds(payload.output);
    if (missing.length === 0) return {};
    const log = getLogger("fact-id-consistency-guard");
    log.warn(
      {
        event: "fact_id_consistency_violation",
        tool_id: payload.toolId,
        missing_count: missing.length,
        sample_missing: missing.slice(0, 3),
      },
      "tool output declares surfaced_fact_ids that are not present in its facts[]/items[]/contradictions[] payload",
    );
  } catch {
    // Never crash on a guard failure.
  }
  return {};
}

export function registerFactIdConsistencyGuardHook(lifecycle: Lifecycle): void {
  lifecycle.on("post_tool", "fact-id-consistency-guard", factIdConsistencyGuardHook);
}
