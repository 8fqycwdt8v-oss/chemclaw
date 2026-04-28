// post_tool hook: source-cache
//
// Activates after any source-system tool call (query_eln_*, fetch_eln_*,
// query_lims_*, fetch_lims_*, query_instrument_*, fetch_instrument_*).
//
// For each structured fact surfaced in the tool output, inserts a row into
// ingestion_events with event_type='source_fact_observed'. The kg_source_cache
// projector converts these into :Fact nodes with temporal provenance.
//
// Pre-turn stale-fact warning: checks ingestion_events for any
// source_fact_observed payloads where valid_until < now() and injects
// a warning into ctx.scratchpad so the harness can surface it.

import type { Pool } from "pg";
import type { PostToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import { withUserContext } from "../../db/with-user-context.js";

// Tool IDs that trigger the source-cache hook.
const SOURCE_TOOL_PATTERN = /^(query_eln|fetch_eln|query_lims|fetch_lims|query_instrument|fetch_instrument)_/;

// Default TTL for cached facts (7 days).
const DEFAULT_TTL_DAYS = 7;

// Predicates extracted from ELN experiment fields.
const ELN_FIELD_PREDICATES: Record<string, string> = {
  yield_pct: "HAS_YIELD",
  purity_pct: "HAS_PURITY",
  yield: "HAS_YIELD",
  purity: "HAS_PURITY",
  temperature_c: "HAS_TEMPERATURE",
  temp_c: "HAS_TEMPERATURE",
  solvent: "HAS_SOLVENT",
  reaction_time_h: "HAS_REACTION_TIME",
};

// Predicates extracted from LIMS results.
const LIMS_RESULT_PREDICATES: Record<string, string> = {
  result_value: "HAS_RESULT_VALUE",
  purity_pct: "HAS_PURITY",
};

// Predicates extracted from instrument runs.
const INSTRUMENT_RUN_PREDICATES: Record<string, string> = {
  total_area: "HAS_TOTAL_AREA",
};

export interface SourceFactPayload {
  source_system_id: string;
  source_system_timestamp: string;
  fetched_at: string;
  valid_until: string;
  predicate: string;
  subject_id: string;
  object_value: string | number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validUntilIso(daysFromNow: number = DEFAULT_TTL_DAYS): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

// ---------- Fact extraction --------------------------------------------------

function extractElnFacts(entry: Record<string, unknown>, entryId: string): SourceFactPayload[] {
  const facts: SourceFactPayload[] = [];
  const now = nowIso();
  const validUntil = validUntilIso();
  const sourceTs = (entry["modified_at"] as string | undefined) ?? now;

  const fields = entry["fields"] as Record<string, { value?: unknown; displayValue?: unknown }> | undefined;
  if (!fields) return facts;

  for (const [fieldKey, predicate] of Object.entries(ELN_FIELD_PREDICATES)) {
    const fieldObj = fields[fieldKey];
    if (fieldObj && fieldObj.value !== undefined && fieldObj.value !== null) {
      facts.push({
        source_system_id: "benchling",
        source_system_timestamp: sourceTs,
        fetched_at: now,
        valid_until: validUntil,
        predicate,
        subject_id: String(entryId),
        object_value: fieldObj.value as string | number,
      });
    }
  }
  return facts;
}

function extractLimsFacts(result: Record<string, unknown>): SourceFactPayload[] {
  const facts: SourceFactPayload[] = [];
  const now = nowIso();
  const validUntil = validUntilIso();
  const sourceTs = (result["completed_at"] as string | undefined) ?? now;
  const subjectId = String(result["id"] ?? "unknown");

  if (result["result_value"] !== undefined && result["result_value"] !== null) {
    const predicate = (result["analysis_name"] as string | undefined)
      ? `HAS_${(result["analysis_name"] as string).toUpperCase().replace(/\s+/g, "_")}`
      : "HAS_RESULT_VALUE";
    facts.push({
      source_system_id: "starlims",
      source_system_timestamp: sourceTs,
      fetched_at: now,
      valid_until: validUntil,
      predicate,
      subject_id: subjectId,
      object_value: result["result_value"] as string | number,
    });
  }
  return facts;
}

function extractInstrumentFacts(run: Record<string, unknown>): SourceFactPayload[] {
  const facts: SourceFactPayload[] = [];
  const now = nowIso();
  const validUntil = validUntilIso();
  const sourceTs = (run["run_date"] as string | undefined) ?? now;
  const subjectId = String(run["id"] ?? "unknown");

  if (run["total_area"] !== undefined && run["total_area"] !== null) {
    facts.push({
      source_system_id: "waters",
      source_system_timestamp: sourceTs,
      fetched_at: now,
      valid_until: validUntil,
      predicate: "HAS_TOTAL_AREA",
      subject_id: subjectId,
      object_value: run["total_area"] as number,
    });
  }

  // One fact per peak area_pct if present.
  const peaks = run["peaks"] as Array<Record<string, unknown>> | undefined;
  if (peaks) {
    for (const peak of peaks) {
      if (peak["area_pct"] !== undefined && peak["peak_name"]) {
        facts.push({
          source_system_id: "waters",
          source_system_timestamp: sourceTs,
          fetched_at: now,
          valid_until: validUntil,
          predicate: "HAS_PEAK_AREA_PCT",
          subject_id: `${subjectId}:${peak["peak_name"]}`,
          object_value: peak["area_pct"] as number,
        });
      }
    }
  }
  return facts;
}

// ---------- Ingestion events insert ------------------------------------------

async function insertSourceFacts(
  pool: Pool,
  userEntraId: string,
  facts: SourceFactPayload[],
): Promise<void> {
  if (facts.length === 0) return;

  // Use the agent's per-request user context. Earlier code path silently
  // hard-coded "" here, which collides with the strict RLS policies in
  // db/init/12_security_hardening.sql ("user_entra_id IS NOT NULL AND <> ''")
  // — empty-string context fails the gate and the INSERT is silently
  // rejected, dropping every source fact on the floor.
  await withUserContext(pool, userEntraId, async (client) => {
    for (const fact of facts) {
      await client.query(
        `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          "source_fact_observed",
          "source_cache_hook",
          `${fact.source_system_id}:${fact.subject_id}`,
          JSON.stringify(fact),
        ],
      );
    }
  });
}

// ---------- Stale-fact warning -----------------------------------------------

export async function checkStaleFacts(
  pool: Pool,
  scratchpad: Map<string, unknown>,
): Promise<void> {
  try {
    const result = await pool.query<{ count: string }>(
      `SELECT count(*) AS count
       FROM ingestion_events
       WHERE event_type = 'source_fact_observed'
         AND (payload->>'valid_until')::timestamptz < now()
         AND created_at > now() - interval '30 days'`,
    );
    const staleCount = parseInt(result.rows[0]?.count ?? "0", 10);
    if (staleCount > 0) {
      const existingWarnings = (scratchpad.get("staleFactWarnings") as string[]) ?? [];
      existingWarnings.push(
        `[source-cache] ${staleCount} cached source fact(s) have expired (valid_until < now). ` +
        `Consider re-querying the source system if freshness matters for this question.`,
      );
      scratchpad.set("staleFactWarnings", existingWarnings);
    }
  } catch {
    // Non-fatal — stale-fact check is best-effort.
  }
}

// ---------- Main hook export -------------------------------------------------

/**
 * Post-tool hook: source-cache.
 *
 * Extracts structured facts from source-system tool outputs and inserts them
 * into ingestion_events for the kg_source_cache projector to consume.
 */
export async function sourceCachePostToolHook(
  toolId: string,
  output: unknown,
  pool: Pool,
  userEntraId: string,
): Promise<void> {
  if (!SOURCE_TOOL_PATTERN.test(toolId)) return;
  if (!output || typeof output !== "object") return;

  const out = output as Record<string, unknown>;
  const facts: SourceFactPayload[] = [];

  // ELN tools return { entries: [...], source_system: "benchling" }
  // or a single { id, fields, source_system: "benchling" }
  if (out["source_system"] === "benchling") {
    if (Array.isArray(out["entries"])) {
      for (const entry of out["entries"] as Record<string, unknown>[]) {
        facts.push(...extractElnFacts(entry, String(entry["id"] ?? "")));
      }
    } else if (out["id"] && out["fields"]) {
      facts.push(...extractElnFacts(out, String(out["id"])));
    }
  }

  // LIMS tools return { results: [...], source_system: "starlims" }
  // or a single { id, result_value, source_system: "starlims" }
  if (out["source_system"] === "starlims") {
    if (Array.isArray(out["results"])) {
      for (const result of out["results"] as Record<string, unknown>[]) {
        facts.push(...extractLimsFacts(result));
      }
    } else if (out["id"]) {
      facts.push(...extractLimsFacts(out));
    }
  }

  // Instrument tools return { runs: [...], source_system: "waters" }
  // or a single { id, peaks, source_system: "waters" }
  if (out["source_system"] === "waters") {
    if (Array.isArray(out["runs"])) {
      for (const run of out["runs"] as Record<string, unknown>[]) {
        facts.push(...extractInstrumentFacts(run));
      }
    } else if (out["id"]) {
      facts.push(...extractInstrumentFacts(out));
    }
  }

  await insertSourceFacts(pool, userEntraId, facts);
}

/**
 * Register the source-cache hook into a Lifecycle instance.
 *
 * Adapter that wraps the positional `sourceCachePostToolHook(toolId, output,
 * pool, userEntraId)` into the lifecycle's `(payload: PostToolPayload) =>
 * Promise<void>` shape. The existing positional function stays untouched so
 * its current tests (`tests/unit/hooks-source-cache.test.ts`) keep passing.
 */
export function registerSourceCacheHook(lifecycle: Lifecycle, pool: Pool): void {
  lifecycle.on("post_tool", "source-cache", async (payload) => {
    await sourceCachePostToolHook(
      payload.toolId,
      payload.output,
      pool,
      payload.ctx.userEntraId,
    );
  });
}
