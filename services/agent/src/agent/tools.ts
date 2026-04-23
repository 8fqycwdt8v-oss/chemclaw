// Agent tool registry — every tool the autonomous ReAct loop can call.
//
// Control-flow philosophy: the agent is autonomous at the reasoning layer;
// tools are the bounded vocabulary of actions it can take. This file is the
// single source of truth for what the model can do in a turn.
//
// Each tool:
//   - declares a Zod input + output schema (validates both sides)
//   - receives per-turn context (user_entra_id etc.) via the `context` arg
//   - routes through the same RLS / redactor / rate-limit plumbing as HTTP calls

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Pool } from "pg";

import type { McpDrfpClient, McpRdkitClient } from "../mcp-clients.js";
import {
  FindSimilarReactionsInput,
  FindSimilarReactionsOutput,
  findSimilarReactions,
} from "../tools/find-similar-reactions.js";

export interface ToolContext {
  userEntraId: string;
  pool: Pool;
  drfp: McpDrfpClient;
  rdkit: McpRdkitClient;
}

/**
 * Build the tool registry for a given request context.
 *
 * We return a fresh registry per chat turn so the ToolContext (particularly
 * `userEntraId`) is captured in a closure and cannot leak between users.
 */
export function buildTools(ctx: ToolContext) {
  const findSimilarReactionsTool = createTool({
    id: "find_similar_reactions",
    description:
      "Find reactions similar to a seed reaction SMILES across the user's " +
      "accessible projects. Uses DRFP (Differential Reaction Fingerprint) " +
      "for similarity; results are cosine-sorted and RLS-scoped.",
    inputSchema: FindSimilarReactionsInput,
    outputSchema: FindSimilarReactionsOutput,
    execute: async ({ context }) => {
      const input = FindSimilarReactionsInput.parse(context);
      return findSimilarReactions(input, {
        pool: ctx.pool,
        drfp: ctx.drfp,
        userEntraId: ctx.userEntraId,
      });
    },
  });

  const canonicalizeSmilesTool = createTool({
    id: "canonicalize_smiles",
    description:
      "Canonicalize a SMILES string via RDKit and return its InChIKey, " +
      "molecular formula, and molecular weight. Use when you need to verify " +
      "structure identity, compute a canonical form, or derive an InChIKey " +
      "for KG lookup.",
    inputSchema: z.object({
      smiles: z.string().min(1).max(10_000),
      kekulize: z.boolean().optional(),
    }),
    outputSchema: z.object({
      canonical_smiles: z.string(),
      inchikey: z.string(),
      formula: z.string(),
      mw: z.number(),
    }),
    execute: async ({ context }) => {
      const input = z
        .object({ smiles: z.string(), kekulize: z.boolean().optional() })
        .parse(context);
      return ctx.rdkit.canonicalize(input.smiles, input.kekulize ?? false);
    },
  });

  return {
    find_similar_reactions: findSimilarReactionsTool,
    canonicalize_smiles: canonicalizeSmilesTool,
  } as const;
}

export type Tools = ReturnType<typeof buildTools>;
