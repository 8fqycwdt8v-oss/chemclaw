// services/agent-claw/src/core/hooks/conclusion-extractor.ts
//
// post_turn hook: kg-conclusion-extractor (Phase 6 — Universal Knowledge Accumulation)
//
// Reads the turn's buffered chemistry tool outputs from ctx.scratchpad
// ("kg_conclusion_inputs") and asks the LLM to extract ABSTRACTED facts —
// confident, cross-tool conclusions that go beyond any single output.
//
// Flow:
//   1. Read + clear ctx.scratchpad.kg_conclusion_inputs.
//   2. If the buffer is empty or the project context is missing, skip.
//   3. Call LLM (role="judge" — Haiku/Sonnet, non-streaming) with the
//      system prompt and a compact JSON user message.
//   4. Parse the returned JSON array of fact drafts.
//   5. For each valid draft: INSERT into `facts` as derivation_class='ABSTRACTED',
//      derivation_depth=0 (agent-level claims sit above the OBSERVED stack),
//      confidence ≤ 0.70 (ABSTRACTED cap matches INTERPRETED + margin).
//   6. Emit one `extracted_fact` ingestion event per inserted fact so the
//      investigation_scorer / interpreter can pick them up.
//   7. Clear the buffer whether or not extraction succeeded (don't re-process
//      stale tool outputs on the next turn).
//
// Errors are swallowed at warn level — the hook must never fail a turn.
// Uses withUserContext so all DB writes go through RLS (user-scoped facts).

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { LlmProvider } from "../../llm/provider.js";
import type { Lifecycle } from "../lifecycle.js";
import type { PostTurnPayload } from "../types.js";
import type { HookJSONOutput } from "../hook-output.js";
import { withUserContext } from "../../db/with-user-context.js";
import { getLogger } from "../../observability/logger.js";
import type { KgConclusionInput } from "./conclusion-buffer.js";

const SCRATCHPAD_KEY = "kg_conclusion_inputs";
const MAX_ABSTRACTED_CONFIDENCE = 0.70;

const SYSTEM_PROMPT = `\
You are a pharmaceutical chemist knowledge-graph curator. You will receive a
JSON list of tool calls made during an agent turn (tool name, inputs, outputs).
Your job: identify ABSTRACTED conclusions — confident, cross-tool claims that
follow from the combination of results and are not already stated verbatim in a
single tool output.

Return ONLY a JSON array (no preamble). Each element:
{
  "predicate": "<snake_case_claim, e.g. suggests_poor_oral_bioavailability>",
  "subject_label": "<entity type, e.g. Compound>",
  "subject_id_value": "<inchikey, SMILES, or NCE code exactly as it appears in the tool data>",
  "object_value": {"value": <number or string>},
  "unit": "<SI unit or null>",
  "confidence": <0.20–0.70>,
  "reasoning": "<one sentence>"
}

Rules:
- Only emit claims directly supported by the tool data. Do not invent.
- Use confidence 0.60–0.70 for strong multi-tool inference; 0.40–0.59 for
  plausible; 0.20–0.39 for speculative.
- If no ABSTRACTED claims are warranted, return [].
- Keep the array short (0–5 items). Quality over quantity.`;

interface FactDraft {
  predicate?: unknown;
  subject_label?: unknown;
  subject_id_value?: unknown;
  object_value?: unknown;
  unit?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

function confidenceTier(c: number): string {
  // Mirrors the canonical thresholds in fact_extractor/_common.py:confidence_tier().
  // "foundational" (>= 0.85) is unreachable here since MAX_ABSTRACTED_CONFIDENCE = 0.70.
  if (c >= 0.65) return "high";
  if (c >= 0.40) return "medium";
  if (c >= 0.20) return "low";
  return "exploratory";
}

export function registerConclusionExtractorHook(
  lifecycle: Lifecycle,
  deps: { pool: Pool; llm: LlmProvider },
): void {
  const log = getLogger("kg-conclusion-extractor");

  lifecycle.on("post_turn", "kg-conclusion-extractor", async (payload: PostTurnPayload): Promise<HookJSONOutput> => {
    const { ctx } = payload;

    // Read and clear buffer unconditionally so stale data never re-processes.
    const raw = ctx.scratchpad.get(SCRATCHPAD_KEY);
    ctx.scratchpad.delete(SCRATCHPAD_KEY);

    if (!Array.isArray(raw) || raw.length === 0) return {};

    const buf = raw as KgConclusionInput[];
    const projectId = ctx.nceProjectId;
    const userEntraId = ctx.userEntraId;

    if (!projectId) {
      log.debug("kg-conclusion-extractor: no nceProjectId; skipping");
      return {};
    }

    try {
      const userContent = JSON.stringify(
        buf.map((b) => ({ tool: b.toolId, input: b.input, output: b.output })),
      ).slice(0, 32000);

      const rawResult = await deps.llm.completeJson({
        system: SYSTEM_PROMPT,
        user: userContent,
        role: "judge",
      });

      if (!Array.isArray(rawResult)) {
        log.debug("kg-conclusion-extractor: LLM returned non-array; skipping");
        return {};
      }

      let inserted = 0;

      await withUserContext(deps.pool, userEntraId, async (client) => {
        for (const draft of rawResult) {
          if (typeof draft !== "object" || draft === null || Array.isArray(draft)) continue;
          const d = draft as FactDraft;

          const predicate = typeof d.predicate === "string" ? d.predicate.trim() : "";
          const subjectLabel = typeof d.subject_label === "string" ? d.subject_label.trim() : "";
          const subjectIdValue = typeof d.subject_id_value === "string" ? d.subject_id_value.trim() : "";
          if (!predicate || !subjectLabel || !subjectIdValue) continue;

          let confidence = typeof d.confidence === "number" ? d.confidence : 0.40;
          confidence = Math.max(0.01, Math.min(confidence, MAX_ABSTRACTED_CONFIDENCE));
          if (confidence <= 0) continue;

          const objectValue = d.object_value ?? {};
          const unit = typeof d.unit === "string" && d.unit ? d.unit : null;
          const reasoning = typeof d.reasoning === "string" ? d.reasoning : "";

          const factId = randomUUID();
          const tier = confidenceTier(confidence);

          const factRes = await client.query<{ id: string }>(
            `INSERT INTO facts (
               id, project_id, subject_label, subject_id_value, predicate,
               object_value, unit, polarity, derivation_class, confidence,
               confidence_tier, source_table, source_row_id,
               source_fact_ids, extractor_name, derivation_depth
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4, $5,
               $6::jsonb, $7, 'positive', 'ABSTRACTED', $8,
               $9, 'agent_turns', NULL,
               '{}', 'kg-conclusion-extractor', 0
             )
             ON CONFLICT DO NOTHING
             RETURNING id::text`,
            [
              factId,
              projectId,
              subjectLabel,
              subjectIdValue,
              predicate,
              JSON.stringify(objectValue),
              unit,
              confidence,
              tier,
            ],
          );

          const firstRow = factRes.rows[0];
          if (!firstRow) continue;
          const newId = firstRow.id;

          await client.query(
            `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
             VALUES ('extracted_fact', 'facts', $1::uuid,
                     jsonb_build_object(
                       'fact_id', $1::text,
                       'predicate', $2::text,
                       'subject_label', $3::text,
                       'confidence', $4,
                       'reasoning', $5::text,
                       'extractor', 'kg-conclusion-extractor'
                     ))`,
            [newId, predicate, subjectLabel, confidence, reasoning],
          );

          inserted++;
        }
      });

      if (inserted > 0) {
        log.info(
          { inserted, toolCount: buf.length, projectId },
          "kg-conclusion-extractor: inserted ABSTRACTED facts",
        );
      }
    } catch (err) {
      log.warn({ err }, "kg-conclusion-extractor: error (swallowed)");
    }

    return {};
  });
}
