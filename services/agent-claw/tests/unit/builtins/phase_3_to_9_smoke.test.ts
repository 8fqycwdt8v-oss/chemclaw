// Schema-level smoke tests for the rest of the Phase 3–9 builtins.
// One test per builtin, asserting the inputSchema accepts a happy path
// and rejects an obvious malformed input.

import { describe, it, expect } from "vitest";

import { buildSubstructureSearchTool } from "../../../src/tools/builtins/substructure_search.js";
import { buildMatchSmartsCatalogTool } from "../../../src/tools/builtins/match_smarts_catalog.js";
import { buildClassifyCompoundTool } from "../../../src/tools/builtins/classify_compound.js";
import { buildGenerateFocusedLibraryTool } from "../../../src/tools/builtins/generate_focused_library.js";
import { buildFindMatchedPairsTool } from "../../../src/tools/builtins/find_matched_pairs.js";
import { buildEnqueueBatchTool } from "../../../src/tools/builtins/enqueue_batch.js";
import { buildInspectBatchTool } from "../../../src/tools/builtins/inspect_batch.js";
import { buildRunChemspaceScreenTool } from "../../../src/tools/builtins/run_chemspace_screen.js";
import { buildConformerAwareKgQueryTool } from "../../../src/tools/builtins/conformer_aware_kg_query.js";
import { buildQmGeometryOptTool } from "../../../src/tools/builtins/qm_geometry_opt.js";
import { buildQmFrequenciesTool } from "../../../src/tools/builtins/qm_frequencies.js";
import { buildQmFukuiTool } from "../../../src/tools/builtins/qm_fukui.js";
import { buildQmRedoxTool } from "../../../src/tools/builtins/qm_redox_potential.js";
import { buildQmCrestScreenTool } from "../../../src/tools/builtins/qm_crest_screen.js";

const FAKE_POOL = {} as never;
const RDKIT_URL = "http://mcp-rdkit:8001";
const XTB_URL = "http://mcp-xtb:8010";
const CREST_URL = "http://mcp-crest:8014";
const GENCHEM_URL = "http://mcp-genchem:8015";

describe("substructure_search schema", () => {
  const tool = buildSubstructureSearchTool(FAKE_POOL, RDKIT_URL);
  it("accepts valid SMARTS", () => {
    expect(tool.inputSchema.safeParse({ smarts: "[P]" }).success).toBe(true);
  });
  it("rejects empty SMARTS", () => {
    expect(tool.inputSchema.safeParse({ smarts: "" }).success).toBe(false);
  });
  it("rejects SMARTS over 500 chars", () => {
    expect(tool.inputSchema.safeParse({ smarts: "x".repeat(501) }).success).toBe(false);
  });
});

describe("match_smarts_catalog schema", () => {
  const tool = buildMatchSmartsCatalogTool(FAKE_POOL, RDKIT_URL);
  it("accepts smiles only", () => {
    expect(tool.inputSchema.safeParse({ smiles: "CCO" }).success).toBe(true);
  });
  it("accepts optional role filter", () => {
    expect(tool.inputSchema.safeParse({ smiles: "CCO", role: "ligand" }).success).toBe(true);
  });
});

describe("classify_compound schema", () => {
  const tool = buildClassifyCompoundTool(FAKE_POOL);
  it("accepts smiles + optional inchikey", () => {
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", inchikey: "LFQSCWFLJHTTHZ-UHFFFAOYSA-N" }).success,
    ).toBe(true);
  });
});

describe("generate_focused_library schema", () => {
  const tool = buildGenerateFocusedLibraryTool(GENCHEM_URL);
  it("accepts kind=scaffold", () => {
    expect(
      tool.inputSchema.safeParse({ kind: "scaffold", seed_smiles: "c1ccccc1[*:1]" }).success,
    ).toBe(true);
  });
  it("rejects unknown kind", () => {
    expect(
      tool.inputSchema.safeParse({ kind: "magic", seed_smiles: "CCO" }).success,
    ).toBe(false);
  });
  it("caps max_proposals", () => {
    expect(
      tool.inputSchema.safeParse({
        kind: "scaffold", seed_smiles: "c1ccccc1[*:1]", max_proposals: 1_000_000,
      }).success,
    ).toBe(false);
  });
});

describe("find_matched_pairs schema", () => {
  const tool = buildFindMatchedPairsTool(GENCHEM_URL);
  it("default n=20 ok", () => {
    expect(tool.inputSchema.safeParse({ smiles: "CCO" }).success).toBe(true);
  });
});

describe("enqueue_batch schema", () => {
  const tool = buildEnqueueBatchTool(FAKE_POOL);
  it("accepts a known task_kind", () => {
    expect(
      tool.inputSchema.safeParse({
        name: "x", task_kind: "qm_single_point",
        payloads: [{ smiles: "CCO" }],
      }).success,
    ).toBe(true);
  });
  it("rejects an unknown task_kind", () => {
    expect(
      tool.inputSchema.safeParse({
        name: "x", task_kind: "free_lunch", payloads: [{ smiles: "CCO" }],
      }).success,
    ).toBe(false);
  });
  it("caps payloads at 5000", () => {
    const big = Array.from({ length: 6000 }, () => ({ smiles: "CCO" }));
    expect(
      tool.inputSchema.safeParse({
        name: "x", task_kind: "qm_single_point", payloads: big,
      }).success,
    ).toBe(false);
  });
});

describe("inspect_batch schema", () => {
  const tool = buildInspectBatchTool(FAKE_POOL);
  it("requires UUID", () => {
    expect(tool.inputSchema.safeParse({ batch_id: "not-uuid" }).success).toBe(false);
    expect(
      tool.inputSchema.safeParse({ batch_id: "11111111-1111-1111-1111-111111111111" }).success,
    ).toBe(true);
  });
});

describe("run_chemspace_screen schema", () => {
  const tool = buildRunChemspaceScreenTool(FAKE_POOL);
  it("accepts a list-source candidate set", () => {
    expect(
      tool.inputSchema.safeParse({
        name: "x",
        candidates: { from: "list", inchikeys: ["A", "B"] },
        scoring_pipeline: [{ kind: "qm_single_point", params: {} }],
      }).success,
    ).toBe(true);
  });
  it("rejects an empty pipeline", () => {
    expect(
      tool.inputSchema.safeParse({
        name: "x",
        candidates: { from: "list", inchikeys: ["A"] },
        scoring_pipeline: [],
      }).success,
    ).toBe(false);
  });
});

describe("conformer_aware_kg_query schema", () => {
  const tool = buildConformerAwareKgQueryTool(FAKE_POOL);
  it("accepts compounds_with_calculation query", () => {
    expect(
      tool.inputSchema.safeParse({ query: "compounds_with_calculation" }).success,
    ).toBe(true);
  });
  it("rejects unknown query", () => {
    expect(tool.inputSchema.safeParse({ query: "nonsense" }).success).toBe(false);
  });
});

describe("qm_geometry_opt schema", () => {
  const tool = buildQmGeometryOptTool(XTB_URL);
  it("accepts every QmMethod", () => {
    for (const m of ["GFN0", "GFN1", "GFN2", "GFN-FF", "g-xTB", "sTDA-xTB", "IPEA-xTB"]) {
      expect(
        tool.inputSchema.safeParse({ smiles: "CCO", method: m }).success,
      ).toBe(true);
    }
  });
  it("rejects bad threshold", () => {
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", threshold: "ultra-deluxe" }).success,
    ).toBe(false);
  });
});

describe("qm_frequencies / qm_fukui schemas", () => {
  it("frequencies accepts solvent", () => {
    const tool = buildQmFrequenciesTool(XTB_URL);
    expect(
      tool.inputSchema.safeParse({
        smiles: "CCO", solvent_model: "alpb", solvent_name: "water",
      }).success,
    ).toBe(true);
  });
  it("fukui rejects multiplicity 0", () => {
    const tool = buildQmFukuiTool(XTB_URL);
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", multiplicity: 0 }).success,
    ).toBe(false);
  });
});

describe("qm_redox_potential schema", () => {
  const tool = buildQmRedoxTool(XTB_URL);
  it("accepts SHE / Fc references", () => {
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", reference: "SHE" }).success,
    ).toBe(true);
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", reference: "Fc" }).success,
    ).toBe(true);
  });
  it("rejects an unknown reference", () => {
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", reference: "Ag/AgCl" }).success,
    ).toBe(false);
  });
});

describe("qm_crest_screen schema", () => {
  const tool = buildQmCrestScreenTool(CREST_URL);
  it("accepts every mode", () => {
    for (const mode of ["conformers", "tautomers", "protomers"]) {
      expect(
        tool.inputSchema.safeParse({ smiles: "CCO", mode }).success,
      ).toBe(true);
    }
  });
  it("caps n_max at 200", () => {
    expect(
      tool.inputSchema.safeParse({ smiles: "CCO", n_max: 1000 }).success,
    ).toBe(false);
  });
});
