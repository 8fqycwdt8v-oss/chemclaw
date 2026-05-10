// Tests for the tag-maturity post_tool hook.

import { describe, it, expect, vi } from "vitest";
import {
  stampMaturity,
  tagMaturityHook,
  resolveMaturity,
  ARTIFACT_TOOL_IDS,
} from "../../src/core/hooks/tag-maturity.js";
import type { Pool, PoolClient } from "pg";
import type { PostToolPayload } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// stampMaturity unit tests
// ---------------------------------------------------------------------------

describe("stampMaturity", () => {
  it("stamps maturity: EXPLORATORY on a plain object", () => {
    const obj = { result: "some data" };
    const result = stampMaturity(obj) as Record<string, unknown>;
    expect(result.maturity).toBe("EXPLORATORY");
  });

  it("does not overwrite an existing maturity field", () => {
    const obj = { result: "data", maturity: "FOUNDATION" };
    const result = stampMaturity(obj) as Record<string, unknown>;
    expect(result.maturity).toBe("FOUNDATION");
  });

  it("is a no-op for a string (primitive)", () => {
    expect(stampMaturity("hello")).toBe("hello");
  });

  it("is a no-op for a number (primitive)", () => {
    expect(stampMaturity(42)).toBe(42);
  });

  it("is a no-op for null", () => {
    expect(stampMaturity(null)).toBeNull();
  });

  it("is a no-op for an array", () => {
    const arr = [1, 2, 3];
    const result = stampMaturity(arr);
    expect(result).toEqual([1, 2, 3]);
    // Arrays are not stamped.
    expect((result as Record<string, unknown>).maturity).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tagMaturityHook integration
// ---------------------------------------------------------------------------

describe("tagMaturityHook — payload mutation", () => {
  function makePayload(output: unknown): PostToolPayload {
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    return {
      ctx: {
        userEntraId: "test@example.com",
        scratchpad,
        seenFactIds,
      },
      toolId: "test_tool",
      input: {},
      output,
    };
  }

  it("stamps object output in-place", async () => {
    const payload = makePayload({ smiles: "CCO", inchikey: "LFQSCWFLJHTTHZ" });
    await tagMaturityHook(payload);
    expect((payload.output as Record<string, unknown>).maturity).toBe("EXPLORATORY");
  });

  it("is a no-op for primitive output", async () => {
    const payload = makePayload("plain string");
    await tagMaturityHook(payload);
    expect(payload.output).toBe("plain string");
  });

  it("is a no-op for null output", async () => {
    const payload = makePayload(null);
    await tagMaturityHook(payload);
    expect(payload.output).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase C: resolveMaturity + artifactMaturity scratchpad population
// ---------------------------------------------------------------------------

describe("resolveMaturity", () => {
  it("returns EXPLORATORY for a plain object without a maturity field", () => {
    expect(resolveMaturity({ result: "data" })).toBe("EXPLORATORY");
  });

  it("returns WORKING when the output already has maturity=WORKING", () => {
    expect(resolveMaturity({ maturity: "WORKING" })).toBe("WORKING");
  });

  it("returns FOUNDATION when the output already has maturity=FOUNDATION", () => {
    expect(resolveMaturity({ maturity: "FOUNDATION" })).toBe("FOUNDATION");
  });

  it("returns EXPLORATORY for null", () => {
    expect(resolveMaturity(null)).toBe("EXPLORATORY");
  });
});

describe("tagMaturityHook — Phase C scratchpad population", () => {
  it("creates the artifactMaturity map in scratchpad if absent", async () => {
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    const payload: PostToolPayload = {
      ctx: { userEntraId: "test@example.com", scratchpad, seenFactIds },
      toolId: "propose_hypothesis",
      input: {},
      output: { hypothesis_id: "h-001", confidence: 0.8 },
    };
    // No pool — artifact DB write is skipped; map should still be created.
    await tagMaturityHook(payload);
    const maturityMap = scratchpad.get("artifactMaturity");
    expect(maturityMap).toBeInstanceOf(Map);
  });

  it("records hypothesis_id in the artifactMaturity map", async () => {
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    const payload: PostToolPayload = {
      ctx: { userEntraId: "test@example.com", scratchpad, seenFactIds },
      toolId: "propose_hypothesis",
      input: {},
      output: { hypothesis_id: "hyp-abc-123", confidence: 0.7 },
    };
    await tagMaturityHook(payload);
    const maturityMap = scratchpad.get("artifactMaturity") as Map<string, string>;
    expect(maturityMap.get("hyp-abc-123")).toBe("EXPLORATORY");
  });
});

// ---------------------------------------------------------------------------
// ARTIFACT_TOOL_IDS membership — review §3.4, recommendation 2
// ---------------------------------------------------------------------------
//
// The foundation-citation guard's ability to validate chemistry claims and
// the calibrated-signal arm of compute_confidence_ensemble both depend on
// chemistry-tool outputs being persisted as artifacts. Pin the membership
// so a future trim doesn't silently drop chemistry coverage.

describe("ARTIFACT_TOOL_IDS — chemistry prediction tools", () => {
  const CHEMISTRY_PREDICTION_TOOLS = [
    "propose_retrosynthesis",
    "predict_reaction_yield",
    "predict_yield_with_uq",
    "predict_molecular_property",
    "identify_unknown_from_ms",
    "elucidate_mechanism",
  ];

  it.each(CHEMISTRY_PREDICTION_TOOLS)(
    "%s is persisted as an artifact",
    (toolId) => {
      expect(ARTIFACT_TOOL_IDS.has(toolId)).toBe(true);
    },
  );

  it("does NOT include QM tools (already persisted via qm_jobs)", () => {
    // Avoid duplicating the canonical row.
    const QM_TOOLS = [
      "qm_single_point",
      "qm_geometry_opt",
      "qm_frequencies",
      "qm_fukui",
      "qm_redox_potential",
      "qm_crest_screen",
      "run_xtb_workflow",
    ];
    for (const tool of QM_TOOLS) {
      expect(ARTIFACT_TOOL_IDS.has(tool)).toBe(false);
    }
  });

  it("does NOT include canonicalize_smiles (deterministic utility)", () => {
    expect(ARTIFACT_TOOL_IDS.has("canonicalize_smiles")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DB-write path: a chemistry tool's output triggers an artifacts INSERT
// ---------------------------------------------------------------------------
//
// We don't need a real Postgres — withUserContext acquires a PoolClient and
// runs queries through it. A minimal capturing stub is enough to assert the
// INSERT INTO artifacts statement fires with the expected toolId/kind.

describe("tagMaturityHook — chemistry tool persists to artifacts", () => {
  function makeCapturingPool(insertedId: string): {
    pool: Pool;
    captured: { text: string; values: readonly unknown[] }[];
  } {
    const captured: { text: string; values: readonly unknown[] }[] = [];
    const client: Partial<PoolClient> = {
      query: vi.fn(async (textOrConfig: unknown, values?: readonly unknown[]) => {
        const text =
          typeof textOrConfig === "string"
            ? textOrConfig
            : (textOrConfig as { text: string }).text;
        captured.push({ text, values: values ?? [] });
        const isInsert = text.includes("INSERT INTO artifacts");
        return {
          rows: isInsert ? [{ id: insertedId }] : [],
        } as unknown as Awaited<ReturnType<NonNullable<PoolClient["query"]>>>;
      }) as unknown as PoolClient["query"],
      release: vi.fn(),
    };
    const pool: Partial<Pool> = {
      connect: vi.fn(async () => client as PoolClient),
    };
    return { pool: pool as Pool, captured };
  }

  it("INSERTs an artifact row when toolId is predict_reaction_yield", async () => {
    const { pool, captured } = makeCapturingPool(
      "11111111-1111-1111-1111-111111111111",
    );
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    const payload: PostToolPayload = {
      ctx: { userEntraId: "test@example.com", scratchpad, seenFactIds },
      toolId: "predict_reaction_yield",
      input: { rxn_smiles_list: ["A>>B"] },
      output: {
        predictions: [
          { rxn_smiles: "A>>B", predicted_yield: 75, std: 8, model_id: "m@v1" },
        ],
      },
    };

    await tagMaturityHook(payload, pool);

    const insertCall = captured.find((q) => q.text.includes("INSERT INTO artifacts"));
    expect(insertCall).toBeDefined();
    // toolId is bound twice ($1 = kind, $5 = tool_id).
    expect(insertCall!.values[0]).toBe("predict_reaction_yield");
    expect(insertCall!.values[4]).toBe("predict_reaction_yield");

    // artifact_id stamped onto the output so the agent can reference it.
    expect(
      (payload.output as Record<string, unknown>).artifact_id,
    ).toBe("11111111-1111-1111-1111-111111111111");

    // EXPLORATORY by default since the chemistry tool's output didn't
    // assert a higher tier.
    expect(insertCall!.values[3]).toBe("EXPLORATORY");
  });

  it("does NOT INSERT for qm_single_point (qm_jobs is the canonical store)", async () => {
    const { pool, captured } = makeCapturingPool(
      "22222222-2222-2222-2222-222222222222",
    );
    const seenFactIds = new Set<string>();
    const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
    const payload: PostToolPayload = {
      ctx: { userEntraId: "test@example.com", scratchpad, seenFactIds },
      toolId: "qm_single_point",
      input: { smiles: "CC", method: "GFN2" },
      output: { energy_hartree: -5.2, converged: true },
    };

    await tagMaturityHook(payload, pool);

    const insertCall = captured.find((q) => q.text.includes("INSERT INTO artifacts"));
    expect(insertCall).toBeUndefined();
  });
});
