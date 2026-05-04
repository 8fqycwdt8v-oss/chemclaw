// post_tool hook: source-cache
//
// Activates after any source-system tool call (query_eln_*, fetch_eln_*,
// query_lims_*, fetch_lims_*, query_instrument_*, fetch_instrument_*).
//
// For each structured fact surfaced in the tool output, inserts a row into
// ingestion_events with event_type='source_fact_observed'. The kg_source_cache
// projector converts these into :Fact nodes with temporal provenance.
//
// Wire shapes recognised (typed contracts from `services/agent-claw/src/tools/builtins/`):
//
//   ELN — `_eln_shared.ts:ElnEntrySchema`
//     query_eln_experiments         → { items: ElnEntry[], next_cursor }
//     fetch_eln_entry               → ElnEntry (top-level)
//     query_eln_canonical_reactions → { items: CanonicalReaction[] }
//     fetch_eln_canonical_reaction  → CanonicalReactionDetail (top-level;
//                                     CanonicalReaction + ofat_children: ElnEntry[])
//     query_eln_samples_by_entry    → { entry_id, samples: Sample[] }
//     fetch_eln_sample              → Sample (top-level)
//
//   Instrument — `_logs_schemas.ts:LogsDataset`
//     query_instrument_runs     → { datasets: LogsDataset[], next_cursor, valid_until }
//     query_instrument_datasets → { datasets: LogsDataset[], valid_until }
//     fetch_instrument_run      → { dataset: LogsDataset, valid_until }
//
// LIMS adapters do not exist on this branch (the regex prefix is
// future-proofing); when they are added the helper `extractLimsFacts`
// can be re-introduced.

import type { Pool } from "pg";
import type { PostToolPayload } from "../types.js";
import type { Lifecycle } from "../lifecycle.js";
import { withUserContext } from "../../db/with-user-context.js";

// Tool IDs that trigger the source-cache hook.
const SOURCE_TOOL_PATTERN = /^(query_eln|fetch_eln|query_lims|fetch_lims|query_instrument|fetch_instrument)_/;

// Default TTL for cached facts (7 days). Used as a fallback when the wire
// shape doesn't include a `valid_until` field of its own.
const DEFAULT_TTL_DAYS = 7;

// Predicates extracted from ELN entry fields_jsonb (or legacy `fields`).
// Keys are matched case-sensitively against the jsonb top-level keys.
const ELN_FIELD_PREDICATES: Record<string, string> = {
  yield_pct: "HAS_YIELD",
  yield: "HAS_YIELD",
  purity_pct: "HAS_PURITY",
  purity: "HAS_PURITY",
  temperature_c: "HAS_TEMPERATURE",
  temp_c: "HAS_TEMPERATURE",
  solvent: "HAS_SOLVENT",
  reaction_time_h: "HAS_REACTION_TIME",
  reaction_time_hours: "HAS_REACTION_TIME",
  catalyst: "HAS_CATALYST",
  base: "HAS_BASE",
  equiv: "HAS_EQUIV",
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

// Safe stringification for IDs sourced from `unknown`/`Record<string, unknown>`
// payloads. Returns "" for objects/arrays so we don't emit "[object Object]"
// as a fact's subject_id.
function safeStringId(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function validUntilIso(daysFromNow: number = DEFAULT_TTL_DAYS): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString();
}

// Coerce an unknown jsonb value to the fact's `object_value` slot — keeps
// numbers numeric, casts everything else to string. Returns `undefined`
// for nullish so the caller can skip emitting a fact for an absent field.
function toObjectValue(v: unknown): string | number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  return JSON.stringify(v);
}

// ---------- Fact extraction --------------------------------------------------

/**
 * Extract facts from one ELN entry. Handles BOTH the new typed shape
 * (`fields_jsonb` as a flat Record per `_eln_shared.ts:ElnEntrySchema`) AND
 * the legacy shape (`fields[key].value` as a {value, displayValue} envelope)
 * — the legacy shape is preserved so that mock outputs / older tools still
 * extract correctly during a migration window.
 */
function extractElnEntryFacts(entry: Record<string, unknown>): SourceFactPayload[] {
  const facts: SourceFactPayload[] = [];
  const now = nowIso();
  const entryValidUntil =
    typeof entry.valid_until === "string"
      ? (entry.valid_until)
      : validUntilIso();
  const sourceTs =
    (entry.modified_at as string | undefined) ??
    (entry.created_at as string | undefined) ??
    now;
  const subjectId = safeStringId(entry.id);
  if (!subjectId) return facts;

  // New typed shape: fields_jsonb is a flat Record<string, unknown>.
  const fieldsJsonb = entry.fields_jsonb;
  if (fieldsJsonb && typeof fieldsJsonb === "object" && !Array.isArray(fieldsJsonb)) {
    const fj = fieldsJsonb as Record<string, unknown>;
    for (const [key, predicate] of Object.entries(ELN_FIELD_PREDICATES)) {
      const v = toObjectValue(fj[key]);
      if (v !== undefined) {
        facts.push({
          source_system_id: "eln",
          source_system_timestamp: sourceTs,
          fetched_at: now,
          valid_until: entryValidUntil,
          predicate,
          subject_id: subjectId,
          object_value: v,
        });
      }
    }
  }

  // Legacy shape: fields[key] = { value, displayValue }.
  const fields = entry.fields;
  if (fields && typeof fields === "object" && !Array.isArray(fields)) {
    const f = fields as Record<string, unknown>;
    for (const [key, predicate] of Object.entries(ELN_FIELD_PREDICATES)) {
      const fieldObj = f[key];
      if (fieldObj && typeof fieldObj === "object" && "value" in (fieldObj)) {
        const v = toObjectValue((fieldObj as { value?: unknown }).value);
        if (v !== undefined) {
          facts.push({
            source_system_id: "eln",
            source_system_timestamp: sourceTs,
            fetched_at: now,
            valid_until: entryValidUntil,
            predicate,
            subject_id: subjectId,
            object_value: v,
          });
        }
      }
    }
  }

  return facts;
}

/**
 * Extract facts from one canonical reaction (`_eln_shared.ts:CanonicalReactionSchema`).
 * mean_yield is the headline aggregate; ofat_children (when present in the
 * Detail variant) recurse through extractElnEntryFacts.
 */
function extractCanonicalReactionFacts(rxn: Record<string, unknown>): SourceFactPayload[] {
  const facts: SourceFactPayload[] = [];
  const now = nowIso();
  const validUntil =
    typeof rxn.valid_until === "string" ? (rxn.valid_until) : validUntilIso();
  const sourceTs =
    (rxn.last_activity_at as string | undefined) ?? now;
  const subjectId = safeStringId(rxn.reaction_id);
  if (!subjectId) return facts;

  const meanYield = toObjectValue(rxn.mean_yield);
  if (meanYield !== undefined) {
    facts.push({
      source_system_id: "eln",
      source_system_timestamp: sourceTs,
      fetched_at: now,
      valid_until: validUntil,
      predicate: "HAS_MEAN_YIELD",
      subject_id: subjectId,
      object_value: meanYield,
    });
  }

  const ofatCount = toObjectValue(rxn.ofat_count);
  if (ofatCount !== undefined) {
    facts.push({
      source_system_id: "eln",
      source_system_timestamp: sourceTs,
      fetched_at: now,
      valid_until: validUntil,
      predicate: "HAS_OFAT_COUNT",
      subject_id: subjectId,
      object_value: ofatCount,
    });
  }

  return facts;
}

/**
 * Extract facts from one ELN sample (`_eln_shared.ts:SampleSchema`). The
 * top-level `purity_pct` and `amount_mg` are emitted directly; nested
 * `results[]` (each a `ResultSchema` with `metric` + `value_num`) are
 * emitted with predicates derived from `metric`.
 */
function extractSampleFacts(sample: Record<string, unknown>): SourceFactPayload[] {
  const facts: SourceFactPayload[] = [];
  const now = nowIso();
  const validUntil =
    typeof sample.valid_until === "string"
      ? (sample.valid_until)
      : validUntilIso();
  const sourceTs =
    (sample.created_at as string | undefined) ?? now;
  const subjectId = safeStringId(sample.id);
  if (!subjectId) return facts;

  const purity = toObjectValue(sample.purity_pct);
  if (purity !== undefined) {
    facts.push({
      source_system_id: "eln",
      source_system_timestamp: sourceTs,
      fetched_at: now,
      valid_until: validUntil,
      predicate: "HAS_PURITY",
      subject_id: subjectId,
      object_value: purity,
    });
  }

  const amount = toObjectValue(sample.amount_mg);
  if (amount !== undefined) {
    facts.push({
      source_system_id: "eln",
      source_system_timestamp: sourceTs,
      fetched_at: now,
      valid_until: validUntil,
      predicate: "HAS_AMOUNT_MG",
      subject_id: subjectId,
      object_value: amount,
    });
  }

  // Nested results: each row has metric + value_num (or value_text).
  if (Array.isArray(sample.results)) {
    for (const r of sample.results as Record<string, unknown>[]) {
      const metric = typeof r.metric === "string" ? (r.metric) : null;
      if (!metric) continue;
      const value = toObjectValue(r.value_num ?? r.value_text);
      if (value === undefined) continue;
      const measuredAt =
        (r.measured_at as string | undefined) ?? sourceTs;
      const predicate = `HAS_${metric.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
      facts.push({
        source_system_id: "eln",
        source_system_timestamp: measuredAt,
        fetched_at: now,
        valid_until: validUntil,
        predicate,
        subject_id: `${subjectId}:${safeStringId(r.id) || metric}`,
        object_value: value,
      });
    }
  }

  return facts;
}

/**
 * Extract facts from one analytical dataset (`_logs_schemas.ts:LogsDataset`).
 * The dataset itself is opaque (no fixed numeric facts) but `parameters` is
 * a typed Record we can mine for instrument-kind-relevant numbers, and the
 * cross-link to `sample_id` is itself a useful fact.
 */
function extractInstrumentFacts(dataset: Record<string, unknown>): SourceFactPayload[] {
  const facts: SourceFactPayload[] = [];
  const now = nowIso();
  const validUntil = validUntilIso();
  const sourceTs =
    (dataset.measured_at as string | undefined) ?? now;
  const subjectId = safeStringId(dataset.uid) || safeStringId(dataset.id);
  if (!subjectId) return facts;

  // Cross-link fact: dataset → sample.
  const sampleId = dataset.sample_id;
  if (typeof sampleId === "string" && sampleId.length > 0) {
    facts.push({
      source_system_id: "logs-sciy",
      source_system_timestamp: sourceTs,
      fetched_at: now,
      valid_until: validUntil,
      predicate: "MEASURED_FROM_SAMPLE",
      subject_id: subjectId,
      object_value: sampleId,
    });
  }

  // Instrument kind as a categorical fact.
  const kind = toObjectValue(dataset.instrument_kind);
  if (kind !== undefined) {
    facts.push({
      source_system_id: "logs-sciy",
      source_system_timestamp: sourceTs,
      fetched_at: now,
      valid_until: validUntil,
      predicate: "HAS_INSTRUMENT_KIND",
      subject_id: subjectId,
      object_value: kind,
    });
  }

  // Mine parameters jsonb for known numeric facts; mirrors the ELN
  // fields_jsonb extraction pattern.
  const params = dataset.parameters;
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const p = params as Record<string, unknown>;
    for (const [key, predicate] of Object.entries({
      total_area: "HAS_TOTAL_AREA",
      area_pct: "HAS_AREA_PCT",
      retention_time_min: "HAS_RETENTION_TIME",
      purity_pct: "HAS_PURITY",
    })) {
      const v = toObjectValue(p[key]);
      if (v !== undefined) {
        facts.push({
          source_system_id: "logs-sciy",
          source_system_timestamp: sourceTs,
          fetched_at: now,
          valid_until: validUntil,
          predicate,
          subject_id: subjectId,
          object_value: v,
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
      // ingestion_events.source_row_id is typed UUID; the projector reads
      // everything it needs (source_system_id, subject_id, predicate,
      // object_value, …) from the payload column, so we pass NULL for the
      // ID column and keep the colon-joined identifier inside payload.
      // The previous code passed `<sys>:<subject>` here which Postgres
      // rejects with `invalid input syntax for type uuid`; a unit test
      // mocked the DB so the schema mismatch never surfaced in CI.
      await client.query(
        `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
         VALUES ($1, $2, NULL, $3::jsonb)`,
        [
          "source_fact_observed",
          "source_cache_hook",
          JSON.stringify(fact),
        ],
      );
    }
  });
}

// ---------- Main hook export -------------------------------------------------

/**
 * Post-tool hook: source-cache.
 *
 * Extracts structured facts from source-system tool outputs and inserts them
 * into ingestion_events for the kg_source_cache projector to consume.
 *
 * Shape detection is structural (no `source_system` discriminator field) so
 * the hook works against the typed Zod contracts emitted by the FastAPI MCP
 * adapters in `services/agent-claw/src/tools/builtins/`.
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

  // Top-level ELN entry (`fetch_eln_entry`): has id + fields_jsonb (or legacy fields).
  if (
    typeof out.id === "string" &&
    (typeof out.fields_jsonb === "object" ||
      typeof out.fields === "object" ||
      typeof out.entry_shape === "string")
  ) {
    facts.push(...extractElnEntryFacts(out));
  }

  // Top-level ELN sample (`fetch_eln_sample`): has id + sample_code + entry_id.
  if (
    typeof out.id === "string" &&
    typeof out.sample_code === "string" &&
    typeof out.entry_id === "string"
  ) {
    facts.push(...extractSampleFacts(out));
  }

  // Top-level CanonicalReactionDetail (`fetch_eln_canonical_reaction`):
  // has reaction_id; may include ofat_children which are ElnEntries.
  if (typeof out.reaction_id === "string") {
    facts.push(...extractCanonicalReactionFacts(out));
    if (Array.isArray(out.ofat_children)) {
      for (const child of out.ofat_children as Record<string, unknown>[]) {
        facts.push(...extractElnEntryFacts(child));
      }
    }
  }

  // `items: [...]` envelope (query_eln_experiments,
  // query_eln_canonical_reactions). The element shape determines extraction.
  if (Array.isArray(out.items)) {
    for (const item of out.items as Record<string, unknown>[]) {
      if (typeof item.reaction_id === "string") {
        facts.push(...extractCanonicalReactionFacts(item));
        if (Array.isArray(item.ofat_children)) {
          for (const child of item.ofat_children as Record<string, unknown>[]) {
            facts.push(...extractElnEntryFacts(child));
          }
        }
      } else if (typeof item.id === "string") {
        facts.push(...extractElnEntryFacts(item));
      }
    }
  }

  // `samples: [...]` envelope (query_eln_samples_by_entry).
  if (Array.isArray(out.samples)) {
    for (const sample of out.samples as Record<string, unknown>[]) {
      facts.push(...extractSampleFacts(sample));
    }
  }

  // `datasets: [...]` envelope (query_instrument_runs, query_instrument_datasets).
  if (Array.isArray(out.datasets)) {
    for (const ds of out.datasets as Record<string, unknown>[]) {
      facts.push(...extractInstrumentFacts(ds));
    }
  }

  // `dataset: ...` envelope (fetch_instrument_run wraps a single LogsDataset).
  if (out.dataset && typeof out.dataset === "object" && !Array.isArray(out.dataset)) {
    facts.push(...extractInstrumentFacts(out.dataset as Record<string, unknown>));
  }

  // Top-level LogsDataset (rare — included for symmetry; the typed adapters
  // wrap in `{ dataset }` instead).
  if (typeof out.uid === "string" && typeof out.instrument_kind === "string") {
    facts.push(...extractInstrumentFacts(out));
  }

  await insertSourceFacts(pool, userEntraId, facts);
}

/**
 * Register the source-cache hook into a Lifecycle instance.
 *
 * Adapter that wraps the positional `sourceCachePostToolHook(toolId, output,
 * pool, userEntraId)` into the lifecycle's HookJSONOutput shape.
 */
export function registerSourceCacheHook(lifecycle: Lifecycle, pool: Pool): void {
  lifecycle.on(
    "post_tool",
    "source-cache",
    async (payload: PostToolPayload, _toolUseID, options) => {
      // Audit M11: skip the DB write if the per-call AbortSignal already
      // fired (route disconnect, hook timeout). The fact extraction is
      // pure-function so even a partial run hasn't caused side effects;
      // bailing here just avoids burning pool time.
      if (options.signal.aborted) return {};
      await sourceCachePostToolHook(
        payload.toolId,
        payload.output,
        pool,
        payload.ctx.userEntraId,
      );
      return {};
    },
  );
}
