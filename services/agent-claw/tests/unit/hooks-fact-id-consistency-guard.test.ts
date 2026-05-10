// Tests for the fact-id consistency guard (post_tool).

import { describe, it, expect, vi } from "vitest";
import {
  collectActualFactIds,
  factIdConsistencyGuardHook,
  findMissingFactIds,
} from "../../src/core/hooks/fact-id-consistency-guard.js";
import * as logger from "../../src/observability/logger.js";
import { makeCtx } from "../helpers/make-ctx.js";

const UUID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const UUID_B = "bbbbbbbb-1111-2222-3333-444444444444";
const UUID_C = "cccccccc-1111-2222-3333-444444444444";

describe("collectActualFactIds", () => {
  it("collects from facts[]", () => {
    const ids = collectActualFactIds({ facts: [{ fact_id: UUID_A }, { fact_id: UUID_B }] });
    expect(ids.has(UUID_A)).toBe(true);
    expect(ids.has(UUID_B)).toBe(true);
  });

  it("collects from items[] of kind 'fact'", () => {
    const ids = collectActualFactIds({
      items: [
        { kind: "fact", fact: { fact_id: UUID_A } },
        { kind: "chunk", chunk: { id: "ignored" } },
      ],
    });
    expect(ids.has(UUID_A)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("collects from contradictions[].fact_ids[]", () => {
    const ids = collectActualFactIds({
      contradictions: [{ fact_ids: [UUID_A, UUID_B] }],
    });
    expect(ids.has(UUID_A)).toBe(true);
    expect(ids.has(UUID_B)).toBe(true);
  });

  it("collects a top-level fact_id (query_provenance shape)", () => {
    const ids = collectActualFactIds({ fact_id: UUID_A });
    expect(ids.has(UUID_A)).toBe(true);
  });

  it("returns empty for non-object output", () => {
    expect(collectActualFactIds(null).size).toBe(0);
    expect(collectActualFactIds("nope").size).toBe(0);
    expect(collectActualFactIds(42).size).toBe(0);
  });
});

describe("findMissingFactIds", () => {
  it("returns empty when surfaced_fact_ids is absent", () => {
    expect(findMissingFactIds({ facts: [{ fact_id: UUID_A }] })).toEqual([]);
  });

  it("returns empty when every declared id is present in facts[]", () => {
    expect(
      findMissingFactIds({
        surfaced_fact_ids: [UUID_A, UUID_B],
        facts: [{ fact_id: UUID_A }, { fact_id: UUID_B }],
      }),
    ).toEqual([]);
  });

  it("flags ids declared but not present in any fact-bearing field", () => {
    expect(
      findMissingFactIds({
        surfaced_fact_ids: [UUID_A, UUID_B, UUID_C],
        facts: [{ fact_id: UUID_A }],
      }),
    ).toEqual([UUID_B, UUID_C]);
  });

  it("accepts items[] as a fact-bearing field", () => {
    expect(
      findMissingFactIds({
        surfaced_fact_ids: [UUID_A],
        items: [{ kind: "fact", fact: { fact_id: UUID_A } }],
      }),
    ).toEqual([]);
  });

  it("accepts contradictions[] as a fact-bearing field", () => {
    expect(
      findMissingFactIds({
        surfaced_fact_ids: [UUID_A, UUID_B],
        contradictions: [{ fact_ids: [UUID_A, UUID_B] }],
      }),
    ).toEqual([]);
  });
});

describe("factIdConsistencyGuardHook (post_tool)", () => {
  it("is a no-op when surfaced_fact_ids is absent", async () => {
    const warn = vi.fn();
    vi.spyOn(logger, "getLogger").mockReturnValue({ warn } as never);

    const ctx = makeCtx();
    await factIdConsistencyGuardHook({
      ctx,
      toolId: "query_kg",
      input: {},
      output: { facts: [{ fact_id: UUID_A }] },
    });

    expect(warn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("is a no-op when every declared id is actually present", async () => {
    const warn = vi.fn();
    vi.spyOn(logger, "getLogger").mockReturnValue({ warn } as never);

    const ctx = makeCtx();
    await factIdConsistencyGuardHook({
      ctx,
      toolId: "expand_reaction_context",
      input: {},
      output: {
        surfaced_fact_ids: [UUID_A, UUID_B],
        facts: [{ fact_id: UUID_A }, { fact_id: UUID_B }],
      },
    });

    expect(warn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("emits a structured warning when declared ids are missing from the payload", async () => {
    const warn = vi.fn();
    vi.spyOn(logger, "getLogger").mockReturnValue({ warn } as never);

    const ctx = makeCtx();
    const result = await factIdConsistencyGuardHook({
      ctx,
      toolId: "expand_reaction_context",
      input: {},
      output: {
        surfaced_fact_ids: [UUID_A, UUID_B, UUID_C],
        facts: [{ fact_id: UUID_A }],
      },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const [logObj] = warn.mock.calls[0];
    expect(logObj.event).toBe("fact_id_consistency_violation");
    expect(logObj.tool_id).toBe("expand_reaction_context");
    expect(logObj.missing_count).toBe(2);
    expect(logObj.sample_missing).toEqual([UUID_B, UUID_C]);
    // Hook never throws or denies — return is empty.
    expect(result).toEqual({});
    vi.restoreAllMocks();
  });

  it("never throws even when given malformed input", async () => {
    const ctx = makeCtx();
    await expect(
      factIdConsistencyGuardHook({
        ctx,
        toolId: "weird_tool",
        input: {},
        output: undefined as never,
      }),
    ).resolves.toEqual({});
  });
});
