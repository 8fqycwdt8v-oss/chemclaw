// identify_unknown_from_ms — wraps mcp-sirius MS structure identification.
//
// Uses SIRIUS 6 + CSI:FingerID + CANOPUS to identify an unknown compound
// from MS2 spectrum. Suitable for unknown impurity ID from analytical data.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import type { Citation } from "../../core/types.js";

// ---------- Schemas ----------------------------------------------------------

const Ms2Peak = z.object({
  m_z: z.number().positive(),
  intensity: z.number().positive(),
});

export const IdentifyUnknownFromMsIn = z.object({
  ms2_peaks: z
    .array(Ms2Peak)
    .min(1)
    .max(5000)
    .describe("MS2 peak list as [{m_z, intensity}] pairs."),
  precursor_mz: z
    .number()
    .positive()
    .max(10_000)
    .describe("Precursor m/z (monoisotopic)."),
  ionization: z
    .enum(["positive", "negative"])
    .default("positive")
    .describe("Electrospray ionization mode."),
});
export type IdentifyUnknownFromMsInput = z.infer<typeof IdentifyUnknownFromMsIn>;

const ClassyFireResult = z.object({
  kingdom: z.string().default(""),
  superclass: z.string().default(""),
  class: z.string().default(""),
});

const StructureCandidate = z.object({
  smiles: z.string(),
  name: z.string(),
  score: z.number(),
  classyfire: ClassyFireResult,
});

export const IdentifyUnknownFromMsOut = z.object({
  candidates: z.array(StructureCandidate),
  citation: z.custom<Citation>().optional(),
});
export type IdentifyUnknownFromMsOutput = z.infer<typeof IdentifyUnknownFromMsOut>;

const SiriusOut = z.object({
  candidates: z.array(StructureCandidate),
});

// ---------- Timeout ----------------------------------------------------------

// SIRIUS can take 60-120 s depending on complexity.
const TIMEOUT_MS = 150_000;

// ---------- Factory ----------------------------------------------------------

export function buildIdentifyUnknownFromMsTool(mcpSiriusUrl: string) {
  const base = mcpSiriusUrl.replace(/\/$/, "");

  return defineTool({
    id: "identify_unknown_from_ms",
    description:
      "Identify an unknown compound from an MS2 spectrum using SIRIUS 6 + CSI:FingerID + CANOPUS. " +
      "Returns ranked structural candidates with ClassyFire classification. " +
      "Use for unknown impurity identification from analytical data. Latency ~60-120 s.",
    inputSchema: IdentifyUnknownFromMsIn,
    outputSchema: IdentifyUnknownFromMsOut,
    annotations: { readOnly: true },

    execute: async (_ctx, input) => {
      const result = await postJson(
        `${base}/identify`,
        {
          ms2_peaks: input.ms2_peaks,
          precursor_mz: input.precursor_mz,
          ionization: input.ionization,
        },
        SiriusOut,
        TIMEOUT_MS,
        "mcp-sirius",
      );

      return IdentifyUnknownFromMsOut.parse({
        candidates: result.candidates,
        citation: result.candidates.length > 0
          ? {
              source_id: `sirius:${input.precursor_mz.toFixed(4)}`,
              source_kind: "external_url" as const,
              source_uri: `sirius://ms2/${input.precursor_mz.toFixed(4)}`,
            }
          : undefined,
      });
    },
  });
}
