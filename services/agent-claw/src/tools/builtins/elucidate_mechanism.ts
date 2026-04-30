// elucidate_mechanism — wraps mcp-synthegy-mech.
//
// LLM-guided A* search for arrow-pushing reaction mechanisms. Adapted from
// Bran et al., Matter 2026 (10.1016/j.matt.2026.102812). The search is
// deterministic over a rule-based move grammar (ionization + attack moves);
// the LLM only scores candidate next-states 0..10 at each search step.
//
// Limitations the agent should know about:
//   - Ionic chemistry only — radicals and pericyclic mechanisms are upstream
//     future work. The MCP returns a `warnings` entry on radical inputs.
//   - Long mechanisms (>15 moves) degrade in scoring quality.
//   - Cost: typical query is ~200 LLM calls, ~$2-3 in tokens (paper SI-K).

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";

// ---------- Schemas ----------------------------------------------------------

export const ElucidateMechanismIn = z.object({
  reactants_smiles: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "SMILES for the reactants. Multi-component is fine (use '.' to separate, e.g. 'CC=O.[OH-]').",
    ),
  products_smiles: z
    .string()
    .min(1)
    .max(10_000)
    .describe("SMILES for the expected products."),
  max_nodes: z
    .number()
    .int()
    .min(1)
    .max(400)
    .default(200)
    .describe(
      "Upper bound on A* nodes explored. Paper demos hit ~200 LLM calls per mechanism.",
    ),
  conditions: z
    .string()
    .max(500)
    .nullable()
    .optional()
    .describe(
      "Optional reaction conditions (acid, base, heat, catalyst, etc.). Improves scoring.",
    ),
  guidance_prompt: z
    .string()
    .max(4_000)
    .nullable()
    .optional()
    .describe(
      "Optional natural-language hint about the expected mechanism. Materially improves quality (paper Figure 4E).",
    ),
  validate_energies: z
    .boolean()
    .default(false)
    .describe(
      "Phase 3 stub — when true, the response includes a warning that xTB validation is not yet wired.",
    ),
  model: z
    .enum([
      "executor",
      "planner",
      "compactor",
      "claude-sonnet-4-7",
      "claude-sonnet-4-6",
      "claude-opus-4-7",
      "claude-haiku-4-5",
      "gemini-2.5-pro",
      "gpt-4o",
      "deepseek-r1",
    ])
    .default("executor"),
});

export type ElucidateMechanismInput = z.infer<typeof ElucidateMechanismIn>;

const Move = z.object({
  from_smiles: z.string(),
  to_smiles: z.string(),
  score: z.number().min(0).max(10),
  derived_kind: z.enum(["i", "a"]).nullable().optional(),
  derived_atom_x: z.number().int().nullable().optional(),
  derived_atom_y: z.number().int().nullable().optional(),
  energy_delta_hartree: z.number().nullable().optional(),
});

export const ElucidateMechanismOut = z.object({
  moves: z.array(Move),
  reactants_smiles: z.string(),
  products_smiles: z.string(),
  total_llm_calls: z.number().int().nonnegative(),
  total_nodes_explored: z.number().int().nonnegative(),
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  parse_failures: z.number().int().nonnegative(),
  upstream_errors: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
});

export type ElucidateMechanismOutput = z.infer<typeof ElucidateMechanismOut>;

// ---------- Timeouts ---------------------------------------------------------

// Paper demos take ~12 minutes for 60-route synth scoring; a single mechanism
// is typically much faster (~200 LLM calls, parallelized 8-way → ~30 s).
// Cap at 5 minutes to give worst-case-Gemini room without trapping the agent.
const TIMEOUT_SYNTHEGY_MECH_MS = 300_000;

// ---------- Factory ----------------------------------------------------------

export function buildElucidateMechanismTool(mcpSynthegyMechUrl: string) {
  const base = mcpSynthegyMechUrl.replace(/\/$/, "");

  return defineTool({
    id: "elucidate_mechanism",
    description:
      "Propose an electron-pushing reaction mechanism from reactants to products via LLM-guided A* search " +
      "(Bran et al., Matter 2026). Returns intermediate SMILES with per-step LLM scores. " +
      "Ionic chemistry only — radicals and pericyclic mechanisms are not supported. " +
      "Optionally accepts a natural-language guidance prompt to bias the search.",
    inputSchema: ElucidateMechanismIn,
    outputSchema: ElucidateMechanismOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const result = await postJson(
        `${base}/elucidate_mechanism`,
        input,
        ElucidateMechanismOut,
        TIMEOUT_SYNTHEGY_MECH_MS,
        "mcp-synthegy-mech",
      );
      return result;
    },
  });
}
