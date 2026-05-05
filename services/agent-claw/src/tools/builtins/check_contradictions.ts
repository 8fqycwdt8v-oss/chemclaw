// check_contradictions — Phase B.2 builtin.
//
// Surfaces contradictions for an entity. Two contradiction kinds:
//   1. Explicit CONTRADICTS edges (written by KG projector on conflicting triples).
//   2. Parallel current facts: multiple currently-valid edges same predicate,
//      different objects.
//
// All returned fact_ids are harvested by the anti-fabrication post_tool hook.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { QueryKgIn, QueryKgOut } from "./query_kg.js";

// ---------- Schemas ----------------------------------------------------------

const EntityRef = z.object({
  label: z.string().min(1).max(80).regex(/^[A-Z][A-Za-z0-9_]*$/),
  id_property: z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/),
  id_value: z.string().min(1).max(4000),
});

const Predicate = z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/);

export const CheckContradictionsIn = z.object({
  entity: EntityRef,
  predicate: Predicate.optional(),
});
export type CheckContradictionsInput = z.infer<typeof CheckContradictionsIn>;

export const Contradiction = z.object({
  kind: z.enum(["explicit_contradicts_edge", "parallel_current_facts"]),
  predicate: Predicate,
  fact_ids: z.array(z.string().uuid()).min(1),
  summary: z.string(),
});

export const CheckContradictionsOut = z.object({
  contradictions: z.array(Contradiction),
  /** All fact_ids surfaced — harvested by anti-fabrication hook. */
  surfaced_fact_ids: z.array(z.string().uuid()),
});
export type CheckContradictionsOutput = z.infer<typeof CheckContradictionsOut>;

// ---------- Helpers ----------------------------------------------------------

function _objectKey(obj: { label: string; id_value: string }): string {
  return `${obj.label}:${obj.id_value}`;
}

// ---------- Timeout ----------------------------------------------------------

const TIMEOUT_MS = 20_000;

// ---------- Factory ----------------------------------------------------------

export function buildCheckContradictionsTool(mcpKgUrl: string) {
  const base = mcpKgUrl.replace(/\/$/, "");

  return defineTool({
    id: "check_contradictions",
    description:
      "Surface explicit CONTRADICTS edges and parallel current facts for an entity in the KG. " +
      "Does not resolve contradictions — use for deep research only.",
    inputSchema: CheckContradictionsIn,
    outputSchema: CheckContradictionsOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      // Pull all currently-valid outbound facts.
      const currentInput = QueryKgIn.parse({
        entity: input.entity,
        predicate: input.predicate,
        direction: "out",
        include_invalidated: false,
      });
      const current = await postJson(
        `${base}/tools/query_at_time`,
        currentInput,
        QueryKgOut,
        TIMEOUT_MS,
        "mcp-kg",
      );

      // Pull explicit CONTRADICTS edges (include invalidated for full history).
      const contradictsInput = QueryKgIn.parse({
        entity: input.entity,
        predicate: "CONTRADICTS",
        direction: "both",
        include_invalidated: true,
      });
      const contradictsFacts = await postJson(
        `${base}/tools/query_at_time`,
        contradictsInput,
        QueryKgOut,
        TIMEOUT_MS,
        "mcp-kg",
      );

      const out: Array<z.infer<typeof Contradiction>> = [];
      const surfacedIds: string[] = [];

      // 1. Explicit CONTRADICTS edges.
      for (const f of contradictsFacts.facts) {
        out.push({
          kind: "explicit_contradicts_edge",
          predicate: f.predicate,
          fact_ids: [f.fact_id],
          summary:
            `Explicit CONTRADICTS edge: ${f.subject.id_value} ↔ ${f.object.id_value} ` +
            `(confidence ${f.confidence_tier})`,
        });
        surfacedIds.push(f.fact_id);
      }

      // 2. Parallel current facts: same predicate, different objects.
      const byPred = new Map<string, typeof current.facts>();
      for (const f of current.facts) {
        const arr = byPred.get(f.predicate) ?? [];
        arr.push(f);
        byPred.set(f.predicate, arr);
        surfacedIds.push(f.fact_id);
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
            `${facts.length} currently-valid ${pred} edges from ${input.entity.id_value} ` +
            `to ${distinctObjects.size} distinct objects.`,
        });
      }

      return CheckContradictionsOut.parse({
        contradictions: out,
        surfaced_fact_ids: [...new Set(surfacedIds)],
      });
    },
  });
}
