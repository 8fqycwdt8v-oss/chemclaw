// Unit tests for pause/resume/complete_optimization_campaign builtins
// (Tranche 8 F7). Mocks the pool so no DB is required.

import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import {
  buildPauseOptimizationCampaignTool,
  buildResumeOptimizationCampaignTool,
  buildCompleteOptimizationCampaignTool,
} from "../../../src/tools/builtins/optimization_campaign_lifecycle.js";

interface PoolMockOpts {
  /** Initial row state returned by the FOR UPDATE SELECT. null → row missing. */
  campaignRow?: {
    id: string;
    status: "active" | "paused" | "completed" | "aborted";
    etag: number;
    updated_at: string;
  } | null;
}

function makePoolMock(opts: PoolMockOpts) {
  const queries: string[] = [];
  const queryFn = vi.fn(async (sql: string, _params?: unknown[]) => {
    queries.push(sql);
    if (sql.startsWith("SET LOCAL") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT")) {
      return { rows: [] };
    }
    if (sql.includes("FROM optimization_campaigns") && sql.includes("FOR UPDATE")) {
      return { rows: opts.campaignRow ? [opts.campaignRow] : [] };
    }
    if (sql.includes("UPDATE optimization_campaigns")) {
      // Echo a new etag + updated_at; mock the post-update RETURNING shape.
      const oldRow = opts.campaignRow;
      return {
        rows: [
          {
            etag: (oldRow?.etag ?? 0) + 1,
            updated_at: "2026-05-15T20:00:00Z",
          },
        ],
      };
    }
    return { rows: [] };
  });
  return {
    connect: vi.fn(async () => ({ query: queryFn, release: vi.fn() })),
    queries,
    queryFn,
  };
}

const CAMPAIGN_UUID = "aaaaaaaa-1111-2222-3333-444444444444";
const ctx = { userEntraId: "u@example.com" };

describe("pause_optimization_campaign", () => {
  it("active → paused", async () => {
    const pool = makePoolMock({
      campaignRow: { id: CAMPAIGN_UUID, status: "active", etag: 3, updated_at: "2026-05-15T19:00:00Z" },
    });
    const tool = buildPauseOptimizationCampaignTool(pool as unknown as Pool);
    const out = await tool.execute(ctx as never, { campaign_id: CAMPAIGN_UUID });
    expect(out.prior_status).toBe("active");
    expect(out.new_status).toBe("paused");
    expect(out.etag).toBe(4); // bumped
  });

  it("paused → paused is idempotent no-op (etag unchanged)", async () => {
    const pool = makePoolMock({
      campaignRow: { id: CAMPAIGN_UUID, status: "paused", etag: 7, updated_at: "2026-05-15T19:00:00Z" },
    });
    const tool = buildPauseOptimizationCampaignTool(pool as unknown as Pool);
    const out = await tool.execute(ctx as never, { campaign_id: CAMPAIGN_UUID });
    expect(out.prior_status).toBe("paused");
    expect(out.new_status).toBe("paused");
    expect(out.etag).toBe(7); // unchanged
    expect(pool.queries.some((s) => s.includes("UPDATE optimization_campaigns"))).toBe(false);
  });

  it("completed → paused refused", async () => {
    const pool = makePoolMock({
      campaignRow: { id: CAMPAIGN_UUID, status: "completed", etag: 9, updated_at: "..." },
    });
    const tool = buildPauseOptimizationCampaignTool(pool as unknown as Pool);
    await expect(
      tool.execute(ctx as never, { campaign_id: CAMPAIGN_UUID }),
    ).rejects.toThrow(/invalid_transition/);
  });

  it("missing campaign → campaign_not_found", async () => {
    const pool = makePoolMock({ campaignRow: null });
    const tool = buildPauseOptimizationCampaignTool(pool as unknown as Pool);
    await expect(
      tool.execute(ctx as never, { campaign_id: CAMPAIGN_UUID }),
    ).rejects.toThrow(/campaign_not_found/);
  });
});

describe("resume_optimization_campaign", () => {
  it("paused → active", async () => {
    const pool = makePoolMock({
      campaignRow: { id: CAMPAIGN_UUID, status: "paused", etag: 5, updated_at: "..." },
    });
    const tool = buildResumeOptimizationCampaignTool(pool as unknown as Pool);
    const out = await tool.execute(ctx as never, { campaign_id: CAMPAIGN_UUID });
    expect(out.prior_status).toBe("paused");
    expect(out.new_status).toBe("active");
    expect(out.etag).toBe(6);
  });

  it("aborted → active refused", async () => {
    const pool = makePoolMock({
      campaignRow: { id: CAMPAIGN_UUID, status: "aborted", etag: 9, updated_at: "..." },
    });
    const tool = buildResumeOptimizationCampaignTool(pool as unknown as Pool);
    await expect(
      tool.execute(ctx as never, { campaign_id: CAMPAIGN_UUID }),
    ).rejects.toThrow(/invalid_transition/);
  });
});

describe("complete_optimization_campaign", () => {
  it("active → completed", async () => {
    const pool = makePoolMock({
      campaignRow: { id: CAMPAIGN_UUID, status: "active", etag: 4, updated_at: "..." },
    });
    const tool = buildCompleteOptimizationCampaignTool(pool as unknown as Pool);
    const out = await tool.execute(ctx as never, { campaign_id: CAMPAIGN_UUID });
    expect(out.new_status).toBe("completed");
    expect(out.etag).toBe(5);
    expect(out.outcome_summary_recorded).toBe(false);
  });

  it("paused → aborted with outcome", async () => {
    const pool = makePoolMock({
      campaignRow: { id: CAMPAIGN_UUID, status: "paused", etag: 2, updated_at: "..." },
    });
    const tool = buildCompleteOptimizationCampaignTool(pool as unknown as Pool);
    const out = await tool.execute(ctx as never, {
      campaign_id: CAMPAIGN_UUID,
      outcome: "aborted",
      outcome_summary: "no longer needed by the synthesis plan",
    });
    expect(out.new_status).toBe("aborted");
  });

  it("completed → completed refused (terminal)", async () => {
    const pool = makePoolMock({
      campaignRow: { id: CAMPAIGN_UUID, status: "completed", etag: 7, updated_at: "..." },
    });
    const tool = buildCompleteOptimizationCampaignTool(pool as unknown as Pool);
    await expect(
      tool.execute(ctx as never, { campaign_id: CAMPAIGN_UUID }),
    ).rejects.toThrow(/invalid_transition/);
  });
});
