// Tool: check_contradictions
//
// Surface contradictions for an entity. Two kinds of contradiction are
// detected:
//   1. Explicit CONTRADICTS edges between facts (written by the KG projector
//      when the ingestion pipeline detects conflicting values on the same
//      subject/predicate/object triple).
//   2. Parallel edges: multiple currently-valid (t_valid_to IS NULL AND
//      invalidated_at IS NULL) edges with the same predicate-from-subject
//      whose object differs — e.g., two yield claims on the same reaction.
//
// This is a DEEP RESEARCH tool. It is deliberately narrow: it surfaces
// conflicts, it does not resolve them. Resolution is an expert-correction
// workflow (Phase 6 of the plan).

import { z } from "zod";

import type { McpKgClient } from "../mcp-clients.js";
import { queryKg, QueryKgInput, QueryKgOutput } from "./query-kg.js";

const EntityRef = z.object({
  label: z.string().min(1).max(80).regex(/^[A-Z][A-Za-z0-9_]*$/),
  id_property: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/),
  id_value: z.string().min(1).max(4000),
});

const Predicate = z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/);

export const CheckContradictionsInput = z.object({
  entity: EntityRef,
  /**
   * Optional predicate narrowing. When omitted we scan all outgoing
   * predicates for parallel-fact conflicts.
   */
  predicate: Predicate.optional(),
});
export type CheckContradictionsInput = z.infer<typeof CheckContradictionsInput>;

export const Contradiction = z.object({
  kind: z.enum(["explicit_contradicts_edge", "parallel_current_facts"]),
  predicate: Predicate,
  /**
   * Fact UUIDs involved. For explicit CONTRADICTS edges this is the edge
   * fact (length 1). For parallel_current_facts it is the conflicting
   * facts (length ≥ 2).
   */
  fact_ids: z.array(z.string().uuid()).min(1),
  summary: z.string(),
});
export type Contradiction = z.infer<typeof Contradiction>;

export const CheckContradictionsOutput = z.object({
  contradictions: z.array(Contradiction),
});
export type CheckContradictionsOutput = z.infer<typeof CheckContradictionsOutput>;

export interface CheckContradictionsDeps {
  kg: McpKgClient;
}

function _objectKey(obj: { label: string; id_value: string }): string {
  return `${obj.label}:${obj.id_value}`;
}

export async function checkContradictions(
  input: CheckContradictionsInput,
  deps: CheckContradictionsDeps,
): Promise<CheckContradictionsOutput> {
  const parsed = CheckContradictionsInput.parse(input);

  // Pull all currently-valid outbound facts for this entity.
  const currentQuery = QueryKgInput.parse({
    entity: parsed.entity,
    predicate: parsed.predicate,
    direction: "out",
    include_invalidated: false,
  });
  const current: QueryKgOutput = await queryKg(currentQuery, deps);

  // Pull CONTRADICTS edges explicitly (include invalidated so we see
  // the complete conflict history).
  const contradictsQuery = QueryKgInput.parse({
    entity: parsed.entity,
    predicate: "CONTRADICTS",
    direction: "both",
    include_invalidated: true,
  });
  const contradictsFacts: QueryKgOutput = await queryKg(contradictsQuery, deps);

  const out: Contradiction[] = [];

  // 1. Explicit CONTRADICTS edges
  for (const f of contradictsFacts.facts) {
    out.push({
      kind: "explicit_contradicts_edge",
      predicate: f.predicate,
      fact_ids: [f.fact_id],
      summary:
        `Explicit CONTRADICTS edge: ${f.subject.id_value} ↔ ${f.object.id_value} ` +
        `(confidence ${f.confidence_tier})`,
    });
  }

  // 2. Parallel current facts: same predicate, different objects.
  const byPred = new Map<string, typeof current.facts>();
  for (const f of current.facts) {
    const arr = byPred.get(f.predicate) ?? [];
    arr.push(f);
    byPred.set(f.predicate, arr);
  }
  for (const [pred, facts] of byPred) {
    if (facts.length < 2) continue;
    const distinctObjects = new Set(facts.map((f) => _objectKey(f.object)));
    if (distinctObjects.size < 2) continue;
    out.push({
      kind: "parallel_current_facts",
      predicate: pred,
      fact_ids: facts.map((f) => f.fact_id),
      summary:
        `${facts.length} currently-valid ${pred} edges from ${parsed.entity.id_value} ` +
        `to ${distinctObjects.size} distinct objects.`,
    });
  }

  return CheckContradictionsOutput.parse({ contradictions: out });
}
