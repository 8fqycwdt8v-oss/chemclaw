// pubchem_ghs_lookup — fetches GHS hazard codes for a compound from PubChem
// (gap-plan H0.4).
//
// Calls the public PubChem PUG-View REST API, no auth required:
//
//   GET https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/{key}/cids/JSON
//   GET https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/{cid}/JSON?heading=GHS+Classification
//
// The response shape under PubChem's PUG-View is deeply nested
// `Record.Section[].Section[].Information[].Value.StringWithMarkup[].String`,
// so the builtin walks the tree and extracts:
//   - GHS hazard codes (H200-H499)
//   - GHS pictogram tokens (GHS01-GHS09)
//   - Signal word (Danger / Warning)
//   - Globally-harmonised system classification text (best-effort).
//
// Two input modes: a SMILES (which is canonicalised + InChIKey'd via
// mcp-rdkit before the PubChem call) or a pre-computed InChIKey. The
// SMILES path needs `mcpRdkitUrl`; the InChIKey-only path is a single
// PubChem lookup.
//
// Usage hint to the LLM: "Call this BEFORE recommending or scheduling
// any synthesis step that uses an unfamiliar reagent." The companion
// scheduled-substance pre_tool gate already covers a small curated
// deny-list for chemical-warfare agents and DEA Schedule-I substances;
// pubchem_ghs_lookup widens the safety surface to any of the ~110M
// compounds with a CID in PubChem.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { getLogger } from "../../observability/logger.js";

const log = getLogger("pubchem_ghs_lookup");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const PubchemGhsIn = z
  .object({
    smiles: z.string().min(1).max(10_000).optional(),
    inchikey: z
      .string()
      .regex(/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/)
      .optional(),
  })
  .refine((v) => v.smiles !== undefined || v.inchikey !== undefined, {
    message: "Either smiles or inchikey must be provided.",
  });
export type PubchemGhsInput = z.infer<typeof PubchemGhsIn>;

export const PubchemGhsOut = z.object({
  /** PubChem CID, or null if no compound matched the input. */
  cid: z.number().int().nullable(),
  /** Resolved InChIKey (may differ from input if SMILES was supplied). */
  inchikey: z.string().nullable(),
  /** GHS hazard codes (H200-H499 ranges). Sorted; deduplicated. */
  hazard_codes: z.array(z.string()),
  /** GHS pictogram tokens (GHS01-GHS09). Sorted; deduplicated. */
  pictograms: z.array(z.string()),
  /** Signal word: "Danger", "Warning", or null. */
  signal_word: z.string().nullable(),
  /** Whether the compound has any GHS data at all. False = unknown, NOT safe. */
  has_ghs_data: z.boolean(),
  /** Source URL for citation. */
  source_url: z.string(),
});
export type PubchemGhsOutput = z.infer<typeof PubchemGhsOut>;

// Internal schema for the inchikey-from-smiles MCP roundtrip.
const InchikeyOnlyOut = z.object({ inchikey: z.string() });

const TIMEOUT_MS = 15_000;
const PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov";

// ---------------------------------------------------------------------------
// Hazard / pictogram extraction
// ---------------------------------------------------------------------------

const HAZARD_CODE_RE = /\bH(?:2\d{2}|3\d{2}|4\d{2})\b/g;
const PICTOGRAM_RE = /\bGHS0[1-9]\b/g;
const SIGNAL_WORDS = ["Danger", "Warning"] as const;

interface ExtractedGhs {
  readonly hazard_codes: string[];
  readonly pictograms: string[];
  readonly signal_word: string | null;
}

/**
 * Walk PubChem's nested PUG-View JSON and harvest hazard codes / pictograms /
 * signal word. Tolerant of every layout variant we've seen (Information[]
 * mixed with StringWithMarkup[], URL-only entries, plain Value.Number, etc.).
 */
export function extractGhsFromView(view: unknown): ExtractedGhs {
  const hazardSet = new Set<string>();
  const pictoSet = new Set<string>();
  let signalWord: string | null = null;

  function walk(node: unknown): void {
    if (node === null) return;
    if (typeof node === "string") {
      const lc = node;
      let m: RegExpExecArray | null;
      HAZARD_CODE_RE.lastIndex = 0;
      while ((m = HAZARD_CODE_RE.exec(lc)) !== null) hazardSet.add(m[0]);
      PICTOGRAM_RE.lastIndex = 0;
      while ((m = PICTOGRAM_RE.exec(lc)) !== null) pictoSet.add(m[0]);
      if (signalWord === null) {
        for (const w of SIGNAL_WORDS) {
          if (lc === w) signalWord = w;
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) walk(v);
    }
  }

  walk(view);
  return {
    hazard_codes: [...hazardSet].sort(),
    pictograms: [...pictoSet].sort(),
    signal_word: signalWord,
  };
}

// ---------------------------------------------------------------------------
// PubChem HTTP fetchers (public, no auth)
// ---------------------------------------------------------------------------

async function fetchJson(
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const r = await fetch(url, {
    signal,
    headers: { accept: "application/json" },
  });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(`pubchem upstream ${r.status} for ${url}`);
  }
  return await r.json();
}

interface CidLookupResult {
  readonly IdentifierList?: { readonly CID?: readonly number[] };
}

async function inchikeyToCid(
  inchikey: string,
  signal: AbortSignal,
): Promise<number | null> {
  const url = `${PUBCHEM_BASE}/rest/pug/compound/inchikey/${encodeURIComponent(inchikey)}/cids/JSON`;
  const json = (await fetchJson(url, signal)) as CidLookupResult | null;
  const cid = json?.IdentifierList?.CID?.[0];
  return typeof cid === "number" ? cid : null;
}

async function fetchGhsView(
  cid: number,
  signal: AbortSignal,
): Promise<unknown> {
  const url =
    `${PUBCHEM_BASE}/rest/pug_view/data/compound/${cid}/JSON` +
    `?response_type=display&heading=GHS+Classification`;
  return await fetchJson(url, signal);
}

function ghsSourceUrl(cid: number): string {
  return `${PUBCHEM_BASE}/compound/${cid}#section=GHS-Classification`;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export function buildPubchemGhsLookupTool(mcpRdkitUrl: string) {
  return defineTool({
    id: "pubchem_ghs_lookup",
    description:
      "Look up GHS hazard codes (H-codes), pictograms (GHS01-09), and signal " +
      "word from PubChem for a compound. Provide either a SMILES (resolved " +
      "via RDKit InChIKey) or an InChIKey directly. Returns has_ghs_data=false " +
      "if no GHS section exists, which means UNKNOWN, not safe. Call before " +
      "scheduling any synthesis step with an unfamiliar reagent.",
    inputSchema: PubchemGhsIn,
    outputSchema: PubchemGhsOut,
    annotations: { readOnly: true, openWorld: true },
    execute: async (ctx, input) => {
      // Resolve InChIKey if only SMILES was provided.
      let inchikey: string | null = input.inchikey ?? null;
      if (inchikey === null && input.smiles !== undefined) {
        const resolved = await postJson(
          `${mcpRdkitUrl.replace(/\/$/, "")}/tools/inchikey_from_smiles`,
          { smiles: input.smiles },
          InchikeyOnlyOut,
          TIMEOUT_MS,
          "mcp-rdkit",
          { userEntraId: ctx.userEntraId },
        );
        inchikey = resolved.inchikey;
      }
      if (inchikey === null) {
        throw new Error(
          "pubchem_ghs_lookup: neither smiles nor inchikey resolved",
        );
      }

      const ctl = new AbortController();
      const timer = setTimeout(() => {
        ctl.abort();
      }, TIMEOUT_MS);
      try {
        const cid = await inchikeyToCid(inchikey, ctl.signal);
        if (cid === null) {
          // Compound is not in PubChem. has_ghs_data=false signals UNKNOWN.
          return PubchemGhsOut.parse({
            cid: null,
            inchikey,
            hazard_codes: [],
            pictograms: [],
            signal_word: null,
            has_ghs_data: false,
            source_url: `${PUBCHEM_BASE}/#query=${encodeURIComponent(inchikey)}`,
          });
        }
        const view = await fetchGhsView(cid, ctl.signal);
        if (view === null) {
          return PubchemGhsOut.parse({
            cid,
            inchikey,
            hazard_codes: [],
            pictograms: [],
            signal_word: null,
            has_ghs_data: false,
            source_url: ghsSourceUrl(cid),
          });
        }
        const ghs = extractGhsFromView(view);
        const has_ghs_data =
          ghs.hazard_codes.length > 0 ||
          ghs.pictograms.length > 0 ||
          ghs.signal_word !== null;
        if (has_ghs_data) {
          log.info(
            {
              cid,
              hazard_count: ghs.hazard_codes.length,
              pictogram_count: ghs.pictograms.length,
            },
            "pubchem ghs hit",
          );
        }
        return PubchemGhsOut.parse({
          cid,
          inchikey,
          hazard_codes: ghs.hazard_codes,
          pictograms: ghs.pictograms,
          signal_word: ghs.signal_word,
          has_ghs_data,
          source_url: ghsSourceUrl(cid),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
