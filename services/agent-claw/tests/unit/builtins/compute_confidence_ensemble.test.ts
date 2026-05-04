// Regression test for the bi-temporal predicate on compute_confidence_ensemble.
//
// Tranche 1 / C1 of the KG refactor: the SELECT against `artifacts` MUST
// filter `WHERE superseded_at IS NULL` so the agent never recomputes an
// ensemble against a retracted record. This test pins the predicate so a
// future refactor can't silently drop it.
//
// We don't need a real Postgres here — the predicate lives in the SQL string
// literal, so a captured-query mock is sufficient.

import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { buildComputeConfidenceEnsembleTool } from "../../../src/tools/builtins/compute_confidence_ensemble.js";
import { makeCtx } from "../../helpers/make-ctx.js";

interface CapturedQuery {
  text: string;
  values: readonly unknown[];
}

function makeCapturingPool(rows: unknown[]): {
  pool: Pool;
  captured: CapturedQuery[];
} {
  const captured: CapturedQuery[] = [];
  // Minimal PoolClient stub: query() captures the SQL + values, returns the
  // configured row set on the first call (the artifacts SELECT) and an empty
  // result on every subsequent call (the SET LOCAL inside withUserContext
  // and the final UPDATE artifacts statement).
  const client: Partial<PoolClient> = {
    query: vi.fn(async (textOrConfig: unknown, values?: readonly unknown[]) => {
      const text =
        typeof textOrConfig === "string"
          ? textOrConfig
          : (textOrConfig as { text: string }).text;
      captured.push({ text, values: values ?? [] });
      // The first SELECT returns rows; everything else returns empty.
      // The SET LOCAL calls inside withUserContext don't read rows, so
      // returning an empty result is harmless for them.
      const isArtifactsSelect =
        text.includes("FROM artifacts") && text.includes("SELECT");
      return { rows: isArtifactsSelect ? rows : [] } as unknown as Awaited<
        ReturnType<NonNullable<PoolClient["query"]>>
      >;
    }) as unknown as PoolClient["query"],
    release: vi.fn(),
  };
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient),
  };
  return { pool: pool as Pool, captured };
}

describe("compute_confidence_ensemble — bi-temporal filter", () => {
  it("SELECTs from artifacts with superseded_at IS NULL", async () => {
    const { pool, captured } = makeCapturingPool([
      { id: "11111111-1111-1111-1111-111111111111", payload: {} },
    ]);
    const tool = buildComputeConfidenceEnsembleTool(pool);

    await tool.execute(makeCtx(), {
      artifact_id: "11111111-1111-1111-1111-111111111111",
      cross_model_enabled: false,
    });

    const artifactsSelect = captured.find(
      (q) => q.text.includes("FROM artifacts") && q.text.includes("SELECT"),
    );
    expect(artifactsSelect).toBeDefined();
    expect(artifactsSelect!.text).toContain("superseded_at IS NULL");
  });

  it("treats a superseded artifact as not-found (no row leaked)", async () => {
    // Empty rows simulate the row being filtered by superseded_at.
    const { pool } = makeCapturingPool([]);
    const tool = buildComputeConfidenceEnsembleTool(pool);

    await expect(
      tool.execute(makeCtx(), {
        artifact_id: "11111111-1111-1111-1111-111111111111",
        cross_model_enabled: false,
      }),
    ).rejects.toThrow(/artifact not found/);
  });
});
