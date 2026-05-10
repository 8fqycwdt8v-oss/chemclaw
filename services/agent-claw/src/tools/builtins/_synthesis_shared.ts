// Shared Zod schemas + helpers for the synthesis-campaign builtins.
//
// One umbrella entity (`synthesis_campaigns`) owns a DAG of steps
// (`synthesis_campaign_steps`); per-kind playbooks in
// `skills/synthesis_campaign_orchestrator/SKILL.md` decide which step kinds to
// queue for each campaign kind. See db/init/51_synthesis_campaigns.sql for
// the table definitions and docs/adr/011-synthesis-campaign-orchestration.md
// for the full state-machine.

import { z } from "zod";

export const CampaignKind = z.enum([
  "single_experiment",
  "library_synthesis",
  "screening",
  "bo_campaign",
  "bo_or_die",
]);
export type CampaignKindT = z.infer<typeof CampaignKind>;

export const CampaignStatus = z.enum([
  "proposed",
  "active",
  "awaiting_measurement",
  "paused",
  "completed",
  "aborted",
  "failed",
  "died",
]);
export type CampaignStatusT = z.infer<typeof CampaignStatus>;

export const StepKind = z.enum([
  "retrosynthesis",
  "literature_pull",
  "condition_design",
  "library_design",
  "hte_plate_design",
  "bo_round",
  "forward_prediction",
  "qm_screen",
  "mechanism_check",
  "feasibility_assessment",
  "submit_batch",
  "measurement_wait",
  "ingest_results",
  "readiness_gate",
  "die_check",
  "summary",
]);
export type StepKindT = z.infer<typeof StepKind>;

export const StepStatus = z.enum([
  "pending",
  "in_progress",
  "completed",
  "skipped",
  "failed",
  "cancelled",
]);
export type StepStatusT = z.infer<typeof StepStatus>;

// Free-form JSON values constrained to depth-2 objects of primitives + arrays.
// The narrow recursive schema keeps the LLM honest (no surprise nested objects)
// while still letting goal/policy/inputs/outputs carry useful structure.
type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export const JsonRecord: z.ZodType<{ [key: string]: JsonValue }> = z.lazy(() =>
  z.record(
    z.string(),
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(
        z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.null(),
          JsonRecord,
        ]),
      ),
      JsonRecord,
    ]),
  ),
);

export const StepSummary = z.object({
  id: z.string().uuid(),
  step_index: z.number().int(),
  kind: StepKind,
  status: StepStatus,
  ref_table: z.string().nullable(),
  ref_id: z.string().nullable(),
  depends_on: z.array(z.string().uuid()),
  notes: z.string().nullable().optional(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  inputs: JsonRecord.optional(),
  outputs: JsonRecord.optional(),
});
export type StepSummaryT = z.infer<typeof StepSummary>;

export const CampaignSummary = z.object({
  id: z.string().uuid(),
  nce_project_id: z.string().uuid(),
  agent_session_id: z.string().uuid().nullable(),
  kind: CampaignKind,
  name: z.string(),
  status: CampaignStatus,
  goal: JsonRecord,
  policy: JsonRecord,
  total_steps: z.number().int(),
  completed_steps: z.number().int(),
  outcome_summary: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  etag: z.number().int().nullable().optional(),
});
export type CampaignSummaryT = z.infer<typeof CampaignSummary>;

// Per-kind canonical step ordering. The orchestrator skill's first move is to
// queue these via `add_synthesis_campaign_step`, then `advance_synthesis_campaign`
// walks them in order, dispatching to existing skills/builtins.
export const PLAYBOOK: Record<CampaignKindT, StepKindT[]> = {
  single_experiment: [
    "retrosynthesis",
    "literature_pull",
    "condition_design",
    "feasibility_assessment",
    "forward_prediction",
    "readiness_gate",
    "summary",
  ],
  library_synthesis: [
    "library_design",
    "feasibility_assessment",
    "hte_plate_design",
    "submit_batch",
    "measurement_wait",
    "ingest_results",
    "summary",
  ],
  screening: [
    "condition_design",
    "hte_plate_design",
    "submit_batch",
    "measurement_wait",
    "ingest_results",
    "summary",
  ],
  bo_campaign: [
    "condition_design",
    "bo_round",
    "submit_batch",
    "measurement_wait",
    "ingest_results",
    "readiness_gate",
    "summary",
  ],
  // bo_or_die intentionally does NOT enqueue a `die_check` step — the gate is
  // evaluated campaign-side by advance_synthesis_campaign before each step
  // pick, so a queued `die_check` step would have no associated tool and
  // confuse the orchestrator with "no recommended_tools" turns.
  bo_or_die: [
    "condition_design",
    "bo_round",
    "submit_batch",
    "measurement_wait",
    "ingest_results",
    "readiness_gate",
    "summary",
  ],
};

// What existing skill / builtin the orchestrator should hand control to for
// each step kind. The orchestrator skill prompt cites these directly so the
// agent picks the right tool without re-deriving the mapping.
export const STEP_KIND_TO_TOOL_HINT: Record<StepKindT, string[]> = {
  retrosynthesis:           ["propose_retrosynthesis"],
  literature_pull:          ["search_knowledge", "fetch_original_document"],
  condition_design:         ["recommend_conditions", "find_similar_reactions",
                             "assess_applicability_domain", "score_green_chemistry"],
  library_design:           ["generate_focused_library", "run_chemspace_screen"],
  hte_plate_design:         ["design_plate"],
  bo_round:                 ["start_optimization_campaign", "recommend_next_batch",
                             "ingest_campaign_results", "extract_pareto_front"],
  forward_prediction:       ["predict_reaction_yield", "predict_yield_with_uq"],
  qm_screen:                ["compute_conformer_ensemble", "qm_frequencies",
                             "qm_fukui", "qm_redox_potential", "qm_crest_screen"],
  mechanism_check:          ["elucidate_mechanism"],
  feasibility_assessment:   ["assess_applicability_domain", "score_green_chemistry",
                             "predict_yield_with_uq"],
  submit_batch:             ["enqueue_batch", "kick_workflow_and_wait"],
  measurement_wait:         ["ask_user", "inspect_batch"],
  ingest_results:           ["ingest_campaign_results", "query_eln_canonical_reactions"],
  readiness_gate:           ["compute_confidence_ensemble"],
  die_check:                [],
  summary:                  ["synthesize_insights"],
};

// Map the row pulled out of postgres into the API shape consumed by the LLM.
export interface CampaignRow {
  id: string;
  nce_project_id: string;
  agent_session_id: string | null;
  kind: CampaignKindT;
  name: string;
  status: CampaignStatusT;
  goal: unknown;
  policy: unknown;
  total_steps: number;
  completed_steps: number;
  outcome_summary: string | null;
  created_at: string;
  updated_at: string;
  etag: number;
}

export interface StepRow {
  id: string;
  step_index: number;
  kind: StepKindT;
  status: StepStatusT;
  inputs: unknown;
  outputs: unknown;
  notes: string | null;
  ref_table: string | null;
  ref_id: string | null;
  depends_on: string[];
  started_at: string | null;
  completed_at: string | null;
}

export function rowToCampaign(row: CampaignRow): CampaignSummaryT {
  return CampaignSummary.parse({
    id: row.id,
    nce_project_id: row.nce_project_id,
    agent_session_id: row.agent_session_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    goal: (row.goal ?? {}) as Record<string, JsonValue>,
    policy: (row.policy ?? {}) as Record<string, JsonValue>,
    total_steps: row.total_steps,
    completed_steps: row.completed_steps,
    outcome_summary: row.outcome_summary,
    created_at: typeof row.created_at === "string" ? row.created_at : new Date(row.created_at).toISOString(),
    updated_at: typeof row.updated_at === "string" ? row.updated_at : new Date(row.updated_at).toISOString(),
    etag: row.etag,
  });
}

export function rowToStep(row: StepRow): StepSummaryT {
  return StepSummary.parse({
    id: row.id,
    step_index: row.step_index,
    kind: row.kind,
    status: row.status,
    inputs: (row.inputs ?? {}) as Record<string, JsonValue>,
    outputs: (row.outputs ?? {}) as Record<string, JsonValue>,
    notes: row.notes,
    ref_table: row.ref_table,
    ref_id: row.ref_id,
    depends_on: row.depends_on,
    started_at: row.started_at,
    completed_at: row.completed_at,
  });
}
