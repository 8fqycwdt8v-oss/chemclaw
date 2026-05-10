// Tests for the scheduled-substance-gate pre_tool hook (gap-plan H0.9).

import { describe, it, expect } from "vitest";
import {
  scheduledSubstanceGateHook,
  scanInputForScheduled,
} from "../../src/core/hooks/scheduled-substance-gate.js";
import {
  compileCatalog,
  looksLikeInchiKey,
  normaliseSmiles,
} from "../../src/data/scheduled-substances.js";
import type { PreToolPayload } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(toolId: string, input: unknown): PreToolPayload {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return {
    ctx: {
      userEntraId: "test@example.com",
      scratchpad,
      seenFactIds,
    },
    toolId,
    input,
  };
}

// ---------------------------------------------------------------------------
// Catalog helpers — these exercise the data module directly so a typo in a
// canonical SMILES doesn't silently disable a deny-list entry.
// ---------------------------------------------------------------------------

describe("scheduled-substances catalog", () => {
  it("compiles every entry into the InChIKey + SMILES indexes", () => {
    const cat = compileCatalog();
    expect(cat.entries.length).toBeGreaterThanOrEqual(13);
    // Every entry has at least one SMILES; most have an InChIKey.
    for (const e of cat.entries) {
      expect(e.canonical_smiles.length).toBeGreaterThan(0);
    }
    expect(cat.bySmiles.size).toBeGreaterThanOrEqual(cat.entries.length);
  });

  it("normaliseSmiles strips whitespace but preserves case", () => {
    expect(normaliseSmiles("  CC(C)\tOP(C)(=O)F\n")).toBe("CC(C)OP(C)(=O)F");
    // Aromatic c is lower-case in SMILES; case-fold would corrupt it.
    expect(normaliseSmiles("c1ccccc1")).toBe("c1ccccc1");
  });

  it("looksLikeInchiKey accepts canonical 14-10-1 form (case-insensitive)", () => {
    expect(looksLikeInchiKey("DYAHQFWOVKZOOW-UHFFFAOYSA-N")).toBe(true);
    // Spec mandates upper-case but free-text emission may not respect it,
    // so the shape check is case-insensitive (lookup itself uppercases).
    expect(looksLikeInchiKey("dyahqfwovkzoow-uhfffaoysa-n")).toBe(true);
    expect(looksLikeInchiKey("not-an-inchikey")).toBe(false);
    expect(looksLikeInchiKey("CC(C)OP(C)(=O)F")).toBe(false);
    // Wrong shape (segment lengths) still rejected.
    expect(looksLikeInchiKey("ABCDEF-GHIJK-N")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scanner — the pure function the hook delegates to.
// ---------------------------------------------------------------------------

describe("scanInputForScheduled", () => {
  it("returns null for unrelated input", () => {
    expect(scanInputForScheduled({ smiles: "CC(=O)O" })).toBeNull();
    expect(scanInputForScheduled({ rxn_smiles_list: ["CCO>>CC=O"] })).toBeNull();
    expect(scanInputForScheduled("free-text prompt with no chemistry")).toBeNull();
    expect(scanInputForScheduled(null)).toBeNull();
    expect(scanInputForScheduled(42)).toBeNull();
  });

  it("matches a CWC Schedule-1 canonical SMILES anywhere in the input tree", () => {
    // Sarin canonical SMILES ('CC(C)OP(C)(=O)F') buried inside a nested arg.
    const input = {
      query: "show me retrosyntheses",
      candidates: [
        { id: 1, smiles: "CC(=O)O" },
        { id: 2, smiles: "CC(C)OP(C)(=O)F" }, // sarin
      ],
    };
    const hit = scanInputForScheduled(input);
    expect(hit).not.toBeNull();
    expect(hit!.entry.name).toBe("Sarin (GB)");
    expect(hit!.via).toBe("smiles");
    expect(hit!.entry.severity).toBe("deny");
    expect(hit!.entry.lists).toContain("CWC_SCHEDULE_1");
  });

  it("matches an InChIKey when the input string is shaped like one", () => {
    // VX InChIKey from the catalog.
    const hit = scanInputForScheduled({
      compound: "LBUJPTNKIBCYBY-UHFFFAOYSA-N",
    });
    expect(hit).not.toBeNull();
    expect(hit!.entry.name).toBe("VX");
    expect(hit!.via).toBe("inchikey");
    expect(hit!.entry.severity).toBe("deny");
  });

  it("matches a lowercase InChIKey (free-text emission case)", () => {
    // The shape check is case-insensitive; the lookup uppercases. An LLM
    // emitting the InChIKey in lowercase from training-corpus prose must
    // still trigger the gate.
    const hit = scanInputForScheduled({
      compound: "lbujptnkibcyby-uhfffaoysa-n",
    });
    expect(hit).not.toBeNull();
    expect(hit!.entry.name).toBe("VX");
    expect(hit!.via).toBe("inchikey");
  });

  it("normalises whitespace before matching", () => {
    // Sulfur mustard with an embedded tab.
    const hit = scanInputForScheduled({ smiles: " ClCCSCCCl\t" });
    expect(hit).not.toBeNull();
    expect(hit!.entry.name).toBe("Sulfur mustard (HD)");
    expect(hit!.entry.severity).toBe("deny");
  });

  it("prefers a deny match over an ask match when both are present", () => {
    // Heroin (DEA Schedule I, ask) and sarin (CWC Schedule 1, deny) in the
    // same input. The deny entry must win regardless of input ordering.
    const input = {
      candidates: [
        // Heroin canonical SMILES (ask).
        "CC(=O)OC1C=CC2C3Cc4ccc(OC(C)=O)c5OC1C2(CCN3C)c45",
        // Sarin canonical SMILES (deny).
        "CC(C)OP(C)(=O)F",
      ],
    };
    const hit = scanInputForScheduled(input);
    expect(hit).not.toBeNull();
    expect(hit!.entry.severity).toBe("deny");
    expect(hit!.entry.name).toBe("Sarin (GB)");
  });

  it("returns an ask match when no deny entries match", () => {
    // Thiodiglycol (mustard precursor; EAR Cat 1C; ask).
    const hit = scanInputForScheduled({ reagent: "OCCSCCO" });
    expect(hit).not.toBeNull();
    expect(hit!.entry.severity).toBe("ask");
    expect(hit!.entry.lists).toContain("EAR_CAT_1C");
  });

  it("ignores extremely long strings (no regex backtracking surface)", () => {
    // A 2048-char string should be skipped without scanning the catalog.
    const big = "X".repeat(2048);
    expect(scanInputForScheduled({ blob: big })).toBeNull();
  });

  it("respects MAX_DEPTH so a deeply-nested non-match returns null", () => {
    // 50 levels of nesting; the gate caps at MAX_DEPTH=8 and stops
    // descending. No catalog entry exists at depth 50, so result is null.
    interface Nested {
      x?: Nested;
      smiles?: string;
    }
    let nested: Nested = { smiles: "CC(=O)O" };
    for (let i = 0; i < 50; i++) {
      nested = { x: nested };
    }
    expect(scanInputForScheduled(nested)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hook entry-point — checks the HookJSONOutput shape the dispatcher consumes.
// ---------------------------------------------------------------------------

describe("scheduledSubstanceGateHook", () => {
  it("is a no-op for unrelated input", async () => {
    const payload = makePayload("propose_retrosynthesis", { smiles: "CCO" });
    await expect(scheduledSubstanceGateHook(payload)).resolves.toEqual({});
  });

  it("returns deny + reason for a CWC Schedule-1 hit", async () => {
    const payload = makePayload("design_plate", {
      starting_material: "CC(C)OP(C)(=O)F", // sarin
    });
    const out = await scheduledSubstanceGateHook(payload);
    expect(out).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "deny",
      },
    });
    const reason = (out as { hookSpecificOutput: { permissionDecisionReason: string } })
      .hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("Sarin");
    expect(reason).toContain("CWC_SCHEDULE_1");
    expect(reason).toContain("design_plate");
  });

  it("returns ask + reason for a DEA Schedule-I hit", async () => {
    // MDMA canonical SMILES: 'CC(Cc1ccc2c(c1)OCO2)NC'
    const payload = makePayload("query_eln_canonical_reactions", {
      smiles: "CC(Cc1ccc2c(c1)OCO2)NC",
    });
    const out = await scheduledSubstanceGateHook(payload);
    expect(out).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "pre_tool",
        permissionDecision: "ask",
      },
    });
  });

  it("does not throw on null/undefined input fields", async () => {
    const payload = makePayload("some_tool", {
      a: null,
      b: undefined,
      c: { d: [null, undefined, ""] },
    });
    await expect(scheduledSubstanceGateHook(payload)).resolves.toEqual({});
  });
});
