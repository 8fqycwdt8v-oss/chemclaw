import { describe, it, expect, vi, afterEach } from "vitest";
import { buildExtractParetoFrontTool } from "../../../src/tools/builtins/extract_pareto_front.js";

const URL_ = "http://mcp-reaction-optimizer:8018";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

afterEach(() => vi.unstubAllGlobals());

const CAMPAIGN_DOMAIN = {
  outputs: {
    features: [
      { key: "yield_pct", objective: { type: "MaximizeObjective" } },
      { key: "pmi", objective: { type: "MinimizeObjective" } },
    ],
  },
};

describe("buildExtractParetoFrontTool", () => {
  it("happy path — campaign has measured outcomes, returns Pareto", async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.includes("FROM optimization_campaigns")) {
        return { rows: [{ bofire_domain: CAMPAIGN_DOMAIN }] };
      }
      if (sql.includes("FROM optimization_rounds")) {
        return {
          rows: [
            {
              measured_outcomes: [
                { factor_values: {}, outputs: { yield_pct: 70, pmi: 30 } },
                { factor_values: {}, outputs: { yield_pct: 85, pmi: 80 } },
                { factor_values: {}, outputs: { yield_pct: 50, pmi: 100 } },
              ],
            },
          ],
        };
      }
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query: queryFn, release: vi.fn() })),
    };

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          pareto: [
            { factor_values: {}, outputs: { yield_pct: 70, pmi: 30 } },
            { factor_values: {}, outputs: { yield_pct: 85, pmi: 80 } },
          ],
          n_total: 3,
          n_pareto: 2,
          output_directions: { yield_pct: "maximize", pmi: "minimize" },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildExtractParetoFrontTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      campaign_id: "11111111-2222-3333-4444-555555555555",
    });

    expect(result.n_total).toBe(3);
    expect(result.n_pareto).toBe(2);
    expect(result.output_directions.yield_pct).toBe("maximize");
    expect(result.output_directions.pmi).toBe("minimize");
  });

  it("rejects unknown campaign", async () => {
    const queryFn = vi.fn(async () => ({ rows: [] }));
    const pool = {
      connect: vi.fn(async () => ({ query: queryFn, release: vi.fn() })),
    };
    const tool = buildExtractParetoFrontTool(pool as never, URL_);
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: "11111111-2222-3333-4444-555555555555",
      }),
    ).rejects.toThrow(/campaign_not_found/);
  });

  it("returns empty Pareto when no measured outcomes", async () => {
    const queryFn = vi.fn(async (sql: string) => {
      if (sql.includes("FROM optimization_campaigns")) {
        return { rows: [{ bofire_domain: CAMPAIGN_DOMAIN }] };
      }
      return { rows: [] };
    });
    const pool = {
      connect: vi.fn(async () => ({ query: queryFn, release: vi.fn() })),
    };

    const tool = buildExtractParetoFrontTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      campaign_id: "11111111-2222-3333-4444-555555555555",
    });
    expect(result.n_total).toBe(0);
    expect(result.n_pareto).toBe(0);
  });
});
