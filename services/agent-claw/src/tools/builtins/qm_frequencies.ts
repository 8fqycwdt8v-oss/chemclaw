// qm_frequencies — vibrational analysis + thermo (ZPE, H, G, S, Cv) at 298 K.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { getToolTimeoutMs } from "../../config/tool-timeouts.js";
import { QmRequestBase, QmResponseBase } from "./_qm_base.js";

export const QmFrequenciesIn = QmRequestBase;
export type QmFrequenciesInput = z.infer<typeof QmFrequenciesIn>;

export const QmFrequenciesOut = QmResponseBase.extend({
  frequencies_cm1: z.array(z.number()),
  ir_intensities: z.array(z.number()),
  thermo: z.record(z.string(), z.number()),
});
export type QmFrequenciesOutput = z.infer<typeof QmFrequenciesOut>;

const DEFAULT_TIMEOUT_MS = 300_000;
const TOOL_ID = "qm_frequencies";

export function buildQmFrequenciesTool(mcpXtbUrl: string) {
  const base = mcpXtbUrl.replace(/\/$/, "");
  return defineTool({
    id: TOOL_ID,
    description:
      "Vibrational frequencies, IR intensities, and thermochemistry " +
      "(ZPE / H298 / G298 / S298 / Cv) for a SMILES. Imaginary frequencies " +
      "(< 0 cm-1) signal a saddle point — flag transition states or wrong " +
      "minima. Latency 30 s - 5 min depending on molecule size.",
    inputSchema: QmFrequenciesIn,
    outputSchema: QmFrequenciesOut,
    annotations: { readOnly: true },
    execute: async (ctx, input) => {
      const timeoutMs = await getToolTimeoutMs(TOOL_ID, { user: ctx.userEntraId }, DEFAULT_TIMEOUT_MS);
      return await postJson(
        `${base}/frequencies`,
        input,
        QmFrequenciesOut,
        timeoutMs,
        "mcp-xtb",
      );
    },
  });
}
