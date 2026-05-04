// query_provenance — Tranche 3 / H4 builtin.
//
// Answers "why am I seeing this fact?" for a given fact_id by returning the
// structured Provenance object the write_fact path attached to the edge,
// plus the bi-temporal envelope (valid_from / valid_to / invalidated_at)
// and confidence tier.
//
// Today the chain is one hop deep — the Provenance JSON has source_type,
// source_id, and the agent-run / model-version metadata. Tranche 5's
// kg_documents projector will introduce :Chunk / :Extractor / :Document
// nodes connected via DERIVED_FROM / EXTRACTED_BY / FROM_DOCUMENT, at
// which point this tool's response gains a `chain[]` field that walks
// the graph; the per-edge fields below stay as the foundation.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

// ---------- Schemas ----------------------------------------------------------

const EntityRef = z.object({
  label: z.string().min(1).max(80).regex(/^[A-Z][A-Za-z0-9_]*$/),
  id_property: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/),
  id_value: z.string().min(1).max(4000),
});

const Predicate = z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/);

const GroupId = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/);

export const QueryProvenanceIn = z.object({
  fact_id: z.string().uuid().describe("UUID of the KG fact (edge) to inspect."),
  group_id: GroupId.optional(),
});

export type QueryProvenanceInput = z.infer<typeof QueryProvenanceIn>;

const ProvenanceSchema = z
  .object({
    source_type: z.enum([
      "ELN",
      "SOP",
      "literature",
      "analytical",
      "user_correction",
      "agent_inference",
      "import_tool",
    ]),
    source_id: z.string(),
  })
  .passthrough();

export const QueryProvenanceOut = z.object({
  fact_id: z.string().uuid(),
  subject: EntityRef,
  predicate: Predicate,
  object: EntityRef,
  provenance: ProvenanceSchema,
  confidence_tier: z.enum([
    "expert_validated",
    "multi_source_llm",
    "single_source_llm",
    "expert_disputed",
    "invalidated",
  ]),
  confidence_score: z.number(),
  t_valid_from: z.string(),
  t_valid_to: z.string().nullable(),
  recorded_at: z.string(),
  invalidated_at: z.string().nullable(),
  invalidation_reason: z.string().nullable(),
});

export type QueryProvenanceOutput = z.infer<typeof QueryProvenanceOut>;

const TIMEOUT_MS = 10_000;

// ---------- Factory ----------------------------------------------------------

export function buildQueryProvenanceTool(mcpKgUrl: string) {
  const base = mcpKgUrl.replace(/\/$/, "");
  return defineTool({
    id: "query_provenance",
    description:
      "Look up the provenance of a KG fact by fact_id. Returns the source " +
      "(ELN / SOP / literature / agent_inference / …) plus extractor / " +
      "model-version metadata, the bi-temporal envelope (valid_from / valid_to " +
      "/ invalidated_at), and the confidence tier. Use after a query_kg / " +
      "expand_reaction_context call when the user asks 'why is this fact " +
      "here' or when assessing trustworthiness before propose_hypothesis.",
    inputSchema: QueryProvenanceIn,
    outputSchema: QueryProvenanceOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/tools/get_fact_provenance`,
        input,
        QueryProvenanceOut,
        TIMEOUT_MS,
        "mcp-kg",
      );
    },
  });
}
