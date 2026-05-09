import { describe, it, expect, vi } from "vitest";
import type { QueryResult } from "pg";

import type { ToolContext } from "../../../src/core/types.js";
import { createMockPool } from "../../helpers/mock-pool.js";
import { buildStartSynthesisCampaignTool } from "../../../src/tools/builtins/start_synthesis_campaign.js";
import { buildListSynthesisCampaignsTool } from "../../../src/tools/builtins/list_synthesis_campaigns.js";
import { buildGetSynthesisCampaignTool } from "../../../src/tools/builtins/get_synthesis_campaign.js";
import { buildAddSynthesisCampaignStepTool } from "../../../src/tools/builtins/add_synthesis_campaign_step.js";
import { buildUpdateSynthesisCampaignStepTool } from "../../../src/tools/builtins/update_synthesis_campaign_step.js";
import { buildAdvanceSynthesisCampaignTool } from "../../../src/tools/builtins/advance_synthesis_campaign.js";
import { buildRecordSynthesisCampaignOutcomeTool } from "../../../src/tools/builtins/record_synthesis_campaign_outcome.js";
import { PLAYBOOK } from "../../../src/tools/builtins/_synthesis_shared.js";

const PROJECT_UUID = "00000000-0000-0000-0000-000000000001";
const CAMPAIGN_UUID = "11111111-1111-1111-1111-111111111111";
const STEP_UUID = "22222222-2222-2222-2222-222222222222";
const SESSION_UUID = "33333333-3333-3333-3333-333333333333";

function makeCtx(sessionId: string | null = SESSION_UUID): ToolContext {
  const scratchpad = new Map<string, unknown>();
  if (sessionId) scratchpad.set("session_id", sessionId);
  return {
    userEntraId: "alice@corp.com",
    seenFactIds: new Set(),
    scratchpad,
  };
}

function rows(...r: unknown[]): QueryResult {
  return { rows: r as never, rowCount: r.length, command: "", oid: 0, fields: [] };
}

const NOW_ISO = "2026-05-08T12:00:00.000+00";

const SAMPLE_CAMPAIGN_ROW = {
  id: CAMPAIGN_UUID,
  nce_project_id: PROJECT_UUID,
  agent_session_id: SESSION_UUID,
  kind: "single_experiment" as const,
  name: "Synthesise compound X",
  status: "proposed" as const,
  goal: { target_smiles: "CCO" },
  policy: { auto_advance: true },
  total_steps: 0,
  completed_steps: 0,
  outcome_summary: null,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
  etag: 1,
};

const SAMPLE_STEP_ROW = {
  id: STEP_UUID,
  step_index: 0,
  kind: "retrosynthesis" as const,
  status: "pending" as const,
  inputs: {},
  outputs: {},
  notes: null,
  ref_table: null,
  ref_id: null,
  depends_on: [] as string[],
  started_at: null,
  completed_at: null,
};

// ---------------------------------------------------------------------------
// start_synthesis_campaign
// ---------------------------------------------------------------------------
describe("start_synthesis_campaign", () => {
  it("inserts the campaign and seeds the per-kind playbook", async () => {
    const { pool, dataSpy } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM nce_projects WHERE internal_id")) {
          return rows({ id: PROJECT_UUID });
        }
        if (sql.includes("INSERT INTO synthesis_campaigns")) {
          return rows({ ...SAMPLE_CAMPAIGN_ROW });
        }
        if (sql.includes("INSERT INTO synthesis_campaign_steps")) {
          return rows();
        }
        if (sql.includes("UPDATE synthesis_campaigns SET total_steps")) {
          return rows();
        }
        if (sql.includes("INSERT INTO synthesis_campaign_events")) {
          return rows();
        }
        return rows();
      },
    });

    const tool = buildStartSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), {
      nce_project_internal_id: "NCE-0042",
      kind: "single_experiment",
      name: "Synthesise compound X",
      goal: { target_smiles: "CCO" },
      policy: { auto_advance: true },
      seed_playbook: true,
    });

    expect(out.campaign.id).toBe(CAMPAIGN_UUID);
    expect(out.campaign.kind).toBe("single_experiment");
    expect(out.seeded_step_kinds).toEqual(PLAYBOOK.single_experiment);

    const sqls = dataSpy.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes("INSERT INTO synthesis_campaigns"))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO synthesis_campaign_steps"))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO synthesis_campaign_events"))).toBe(true);
  });

  it("rejects unknown projects", async () => {
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM nce_projects WHERE internal_id")) {
          return rows();
        }
        return rows();
      },
    });
    const tool = buildStartSynthesisCampaignTool(pool);
    await expect(
      tool.execute(makeCtx(), {
        nce_project_internal_id: "BOGUS",
        kind: "bo_or_die",
        name: "x",
        goal: {},
        policy: {},
        seed_playbook: false,
      }),
    ).rejects.toThrow(/nce_project_not_found_or_forbidden/);
  });

  it("requires userEntraId", async () => {
    const { pool } = createMockPool();
    const tool = buildStartSynthesisCampaignTool(pool);
    const ctx = { ...makeCtx(), userEntraId: undefined } as unknown as ToolContext;
    await expect(
      tool.execute(ctx, {
        nce_project_internal_id: "NCE-0042",
        kind: "single_experiment",
        name: "x",
        goal: {},
        policy: {},
        seed_playbook: false,
      }),
    ).rejects.toThrow(/userEntraId/);
  });
});

// ---------------------------------------------------------------------------
// list_synthesis_campaigns
// ---------------------------------------------------------------------------
describe("list_synthesis_campaigns", () => {
  it("returns mapped rows with filters applied", async () => {
    const { pool, dataSpy } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns")) {
          return rows({ ...SAMPLE_CAMPAIGN_ROW });
        }
        return rows();
      },
    });

    const tool = buildListSynthesisCampaignsTool(pool);
    const out = await tool.execute(makeCtx(), {
      status: ["active", "proposed"],
      kind: ["bo_campaign", "bo_or_die"],
      only_mine: true,
      limit: 5,
    });

    expect(out.campaigns).toHaveLength(1);
    expect(out.campaigns[0]!.id).toBe(CAMPAIGN_UUID);
    const sql = dataSpy.mock.calls.map((c) => c[0] as string).find((s) => s.includes("FROM synthesis_campaigns"));
    expect(sql).toMatch(/sc.status = ANY/);
    expect(sql).toMatch(/sc.kind = ANY/);
    expect(sql).toMatch(/sc.created_by_user_entra_id =/);
  });
});

// ---------------------------------------------------------------------------
// get_synthesis_campaign
// ---------------------------------------------------------------------------
describe("get_synthesis_campaign", () => {
  it("hydrates campaign + steps + events", async () => {
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id")) return rows({ ...SAMPLE_CAMPAIGN_ROW });
        if (sql.includes("FROM synthesis_campaign_steps")) return rows({ ...SAMPLE_STEP_ROW });
        if (sql.includes("FROM synthesis_campaign_events")) {
          return rows({
            id: "ev-1",
            step_id: null,
            event_type: "campaign_created",
            payload: { kind: "single_experiment" },
            occurred_at: NOW_ISO,
          });
        }
        return rows();
      },
    });

    const tool = buildGetSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      include_events: true,
      events_limit: 10,
    });
    expect(out.campaign.id).toBe(CAMPAIGN_UUID);
    expect(out.steps).toHaveLength(1);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.event_type).toBe("campaign_created");
  });

  it("throws on missing campaign", async () => {
    const { pool } = createMockPool({ dataHandler: async () => rows() });
    const tool = buildGetSynthesisCampaignTool(pool);
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: CAMPAIGN_UUID,
        include_events: false,
        events_limit: 1,
      }),
    ).rejects.toThrow(/synthesis_campaign_not_found/);
  });
});

// ---------------------------------------------------------------------------
// add_synthesis_campaign_step
// ---------------------------------------------------------------------------
describe("add_synthesis_campaign_step", () => {
  it("rejects depends_on UUIDs that don't belong to the campaign", async () => {
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id")) return rows({ id: CAMPAIGN_UUID });
        if (sql.includes("FROM synthesis_campaign_steps") && sql.includes("ANY($2::uuid[])")) {
          // Caller asked for two deps; we only return one as valid.
          return rows({ id: STEP_UUID });
        }
        return rows();
      },
    });
    const tool = buildAddSynthesisCampaignStepTool(pool);
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: CAMPAIGN_UUID,
        kind: "bo_round",
        inputs: {},
        depends_on: [STEP_UUID, "44444444-4444-4444-4444-444444444444"],
      }),
    ).rejects.toThrow(/depends_on_invalid/);
  });

  it("accepts depends_on UUIDs that all belong to the campaign", async () => {
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id")) return rows({ id: CAMPAIGN_UUID });
        if (sql.includes("FROM synthesis_campaign_steps") && sql.includes("ANY($2::uuid[])")) {
          return rows({ id: STEP_UUID });
        }
        if (sql.includes("COALESCE(MAX(step_index)")) return rows({ next_index: 1 });
        if (sql.includes("INSERT INTO synthesis_campaign_steps")) {
          return rows({ ...SAMPLE_STEP_ROW, depends_on: [STEP_UUID], step_index: 1 });
        }
        if (sql.includes("UPDATE synthesis_campaigns")) return rows();
        if (sql.includes("INSERT INTO synthesis_campaign_events")) return rows();
        return rows();
      },
    });
    const tool = buildAddSynthesisCampaignStepTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      kind: "bo_round",
      inputs: {},
      depends_on: [STEP_UUID],
    });
    expect(out.step.depends_on).toEqual([STEP_UUID]);
  });

  it("computes the next step_index and bumps total_steps", async () => {
    const { pool, dataSpy } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id")) return rows({ id: CAMPAIGN_UUID });
        if (sql.includes("COALESCE(MAX(step_index)")) return rows({ next_index: 4 });
        if (sql.includes("INSERT INTO synthesis_campaign_steps")) return rows({ ...SAMPLE_STEP_ROW, step_index: 4 });
        if (sql.includes("UPDATE synthesis_campaigns")) return rows();
        if (sql.includes("INSERT INTO synthesis_campaign_events")) return rows();
        return rows();
      },
    });

    const tool = buildAddSynthesisCampaignStepTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      kind: "bo_round",
      inputs: {},
      depends_on: [],
    });
    expect(out.step.step_index).toBe(4);

    const sqls = dataSpy.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => /UPDATE synthesis_campaigns[\s\S]+total_steps = total_steps \+ 1/.test(s))).toBe(true);
    expect(sqls.some((s) => s.includes('step_added'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// update_synthesis_campaign_step
// ---------------------------------------------------------------------------
describe("update_synthesis_campaign_step", () => {
  it("increments completed_steps on a fresh terminal transition", async () => {
    const { pool, dataSpy } = createMockPool({
      dataHandler: async (sql, params) => {
        if (sql.includes("SELECT status FROM synthesis_campaign_steps")) return rows({ status: "in_progress" });
        if (sql.includes("UPDATE synthesis_campaign_steps")) {
          return rows({ ...SAMPLE_STEP_ROW, status: "completed", completed_at: NOW_ISO });
        }
        if (sql.includes("UPDATE synthesis_campaigns")) {
          // confirm the +1 increment param was passed
          expect(params?.[1]).toBe(1);
          return rows({ ...SAMPLE_CAMPAIGN_ROW, status: "active", completed_steps: 1 });
        }
        if (sql.includes("INSERT INTO synthesis_campaign_events")) return rows();
        return rows();
      },
    });

    const tool = buildUpdateSynthesisCampaignStepTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      step_id: STEP_UUID,
      status: "completed",
      outputs: { yield_pct: 87 },
      ref_table: "optimization_rounds",
      ref_id: "round-uuid",
    });
    expect(out.step.status).toBe("completed");
    expect(out.campaign.completed_steps).toBe(1);

    // event_type is bound as a parameter, not part of the SQL text
    const eventTypes = dataSpy.mock.calls
      .filter(([sql]) => (sql as string).includes("INSERT INTO synthesis_campaign_events"))
      .map(([, params]) => (params as unknown[])[2]);
    expect(eventTypes).toContain("step_completed");
  });

  it("emits step_skipped when transitioning to skipped", async () => {
    const eventTypes: unknown[] = [];
    const { pool } = createMockPool({
      dataHandler: async (sql, params) => {
        if (sql.includes("SELECT status FROM synthesis_campaign_steps")) return rows({ status: "in_progress" });
        if (sql.includes("UPDATE synthesis_campaign_steps")) {
          return rows({ ...SAMPLE_STEP_ROW, status: "skipped", completed_at: NOW_ISO });
        }
        if (sql.includes("UPDATE synthesis_campaigns")) return rows({ ...SAMPLE_CAMPAIGN_ROW });
        if (sql.includes("INSERT INTO synthesis_campaign_events")) {
          eventTypes.push((params as unknown[])[2]);
          return rows();
        }
        return rows();
      },
    });
    const tool = buildUpdateSynthesisCampaignStepTool(pool);
    await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      step_id: STEP_UUID,
      status: "skipped",
    });
    expect(eventTypes).toContain("step_skipped");
  });

  it("emits step_cancelled when transitioning to cancelled", async () => {
    const eventTypes: unknown[] = [];
    const { pool } = createMockPool({
      dataHandler: async (sql, params) => {
        if (sql.includes("SELECT status FROM synthesis_campaign_steps")) return rows({ status: "in_progress" });
        if (sql.includes("UPDATE synthesis_campaign_steps")) {
          return rows({ ...SAMPLE_STEP_ROW, status: "cancelled", completed_at: NOW_ISO });
        }
        if (sql.includes("UPDATE synthesis_campaigns")) return rows({ ...SAMPLE_CAMPAIGN_ROW });
        if (sql.includes("INSERT INTO synthesis_campaign_events")) {
          eventTypes.push((params as unknown[])[2]);
          return rows();
        }
        return rows();
      },
    });
    const tool = buildUpdateSynthesisCampaignStepTool(pool);
    await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      step_id: STEP_UUID,
      status: "cancelled",
    });
    expect(eventTypes).toContain("step_cancelled");
  });

  it("does NOT double-increment when re-completing an already-terminal step", async () => {
    let updateCampaignParams: unknown[] | undefined;
    const { pool } = createMockPool({
      dataHandler: async (sql, params) => {
        if (sql.includes("SELECT status FROM synthesis_campaign_steps")) return rows({ status: "completed" });
        if (sql.includes("UPDATE synthesis_campaign_steps")) {
          return rows({ ...SAMPLE_STEP_ROW, status: "completed" });
        }
        if (sql.includes("UPDATE synthesis_campaigns")) {
          updateCampaignParams = params;
          return rows({ ...SAMPLE_CAMPAIGN_ROW, completed_steps: 7 });
        }
        if (sql.includes("INSERT INTO synthesis_campaign_events")) return rows();
        return rows();
      },
    });

    const tool = buildUpdateSynthesisCampaignStepTool(pool);
    await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      step_id: STEP_UUID,
      status: "completed",
      notes: "noop re-complete",
    });
    expect(updateCampaignParams?.[1]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// advance_synthesis_campaign
// ---------------------------------------------------------------------------
describe("advance_synthesis_campaign", () => {
  it("returns next_step + recommended_tools and claims the step", async () => {
    let claimedStepId: unknown;
    const { pool } = createMockPool({
      dataHandler: async (sql, params) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id") && sql.includes("FOR UPDATE")) {
          return rows({
            id: CAMPAIGN_UUID,
            kind: "single_experiment",
            status: "proposed",
            policy: {},
            total_steps: 7,
            completed_steps: 0,
          });
        }
        if (sql.includes("FROM synthesis_campaign_steps s") && sql.includes("status = 'pending'")) {
          return rows({
            ...SAMPLE_STEP_ROW,
            kind: "retrosynthesis",
            step_index: 0,
          });
        }
        if (sql.includes("UPDATE synthesis_campaign_steps") && sql.includes("'in_progress'")) {
          claimedStepId = params?.[0];
          return rows();
        }
        if (sql.includes("UPDATE synthesis_campaigns") && sql.includes("'active'")) {
          return rows();
        }
        return rows();
      },
    });

    const tool = buildAdvanceSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), { campaign_id: CAMPAIGN_UUID, claim: true });
    expect(out.decision).toBe("next_step");
    expect(out.step?.kind).toBe("retrosynthesis");
    expect(out.recommended_tools).toContain("propose_retrosynthesis");
    expect(out.campaign_status).toBe("active");
    expect(claimedStepId).toBe(STEP_UUID);
  });

  it("flips campaign to completed when no pending or in_progress steps remain", async () => {
    const { pool, dataSpy } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id") && sql.includes("FOR UPDATE")) {
          return rows({
            id: CAMPAIGN_UUID,
            kind: "single_experiment",
            status: "active",
            policy: {},
            total_steps: 3,
            completed_steps: 3,
          });
        }
        if (sql.includes("FROM synthesis_campaign_steps s") && sql.includes("status = 'pending'")) {
          return rows();
        }
        if (sql.includes("FILTER (WHERE status = 'pending')")) {
          return rows({ pending: 0, in_progress: 0 });
        }
        if (sql.includes("UPDATE synthesis_campaigns") && sql.includes("'completed'")) {
          return rows();
        }
        if (sql.includes("INSERT INTO synthesis_campaign_events")) return rows();
        return rows();
      },
    });

    const tool = buildAdvanceSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), { campaign_id: CAMPAIGN_UUID, claim: true });
    expect(out.decision).toBe("campaign_completed");
    expect(out.campaign_status).toBe("completed");

    const sqls = dataSpy.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('campaign_completed'))).toBe(true);
  });

  it("triggers die for bo_or_die when no-improvement count exceeds policy", async () => {
    const { pool, dataSpy } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id") && sql.includes("FOR UPDATE")) {
          return rows({
            id: CAMPAIGN_UUID,
            kind: "bo_or_die",
            status: "active",
            policy: { die_after_no_improvement_rounds: 2 },
            total_steps: 8,
            completed_steps: 5,
          });
        }
        if (sql.includes("rounds_run") && sql.includes("rounds_with_improvement")) {
          return rows({ rounds_run: 4, rounds_with_improvement: 1, experiments_used: 30 });
        }
        if (sql.includes("UPDATE synthesis_campaigns") && sql.includes("'died'")) return rows();
        if (sql.includes("die_triggered")) return rows();
        return rows();
      },
    });

    const tool = buildAdvanceSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), { campaign_id: CAMPAIGN_UUID, claim: false });
    expect(out.decision).toBe("campaign_died");
    expect(out.campaign_status).toBe("died");
    expect(out.rationale).toMatch(/without improvement/i);

    const sqls = dataSpy.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('die_triggered'))).toBe(true);
  });

  it("triggers die for bo_or_die when experiment budget exhausted", async () => {
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id") && sql.includes("FOR UPDATE")) {
          return rows({
            id: CAMPAIGN_UUID,
            kind: "bo_or_die",
            status: "active",
            policy: { die_after_no_improvement_rounds: 99, budget_max_experiments: 12 },
            total_steps: 8,
            completed_steps: 5,
          });
        }
        if (sql.includes("rounds_run") && sql.includes("rounds_with_improvement")) {
          return rows({ rounds_run: 3, rounds_with_improvement: 3, experiments_used: 12 });
        }
        if (sql.includes("UPDATE synthesis_campaigns") && sql.includes("'died'")) return rows();
        return rows();
      },
    });

    const tool = buildAdvanceSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), { campaign_id: CAMPAIGN_UUID, claim: false });
    expect(out.decision).toBe("campaign_died");
    expect(out.rationale).toMatch(/budget exhausted/i);
  });

  it("does NOT die a regular bo_campaign even when guards would trip", async () => {
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id") && sql.includes("FOR UPDATE")) {
          return rows({
            id: CAMPAIGN_UUID,
            kind: "bo_campaign",
            status: "active",
            policy: { die_after_no_improvement_rounds: 2, budget_max_experiments: 12 },
            total_steps: 8,
            completed_steps: 5,
          });
        }
        if (sql.includes("FROM synthesis_campaign_steps s") && sql.includes("status = 'pending'")) {
          return rows({ ...SAMPLE_STEP_ROW, kind: "bo_round", step_index: 5 });
        }
        if (sql.includes("UPDATE synthesis_campaign_steps")) return rows();
        return rows();
      },
    });

    const tool = buildAdvanceSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), { campaign_id: CAMPAIGN_UUID, claim: true });
    // bo_campaign skips die-check entirely.
    expect(out.decision).toBe("next_step");
  });

  it("returns campaign_terminal for already-completed campaigns", async () => {
    const { pool } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("FROM synthesis_campaigns WHERE id") && sql.includes("FOR UPDATE")) {
          return rows({
            id: CAMPAIGN_UUID,
            kind: "single_experiment",
            status: "completed",
            policy: {},
            total_steps: 3,
            completed_steps: 3,
          });
        }
        return rows();
      },
    });
    const tool = buildAdvanceSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), { campaign_id: CAMPAIGN_UUID, claim: true });
    expect(out.decision).toBe("campaign_terminal");
    expect(out.campaign_status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// record_synthesis_campaign_outcome
// ---------------------------------------------------------------------------
describe("record_synthesis_campaign_outcome", () => {
  it("writes status + outcome_summary and a campaign_completed event", async () => {
    const { pool, dataSpy } = createMockPool({
      dataHandler: async (sql) => {
        if (sql.includes("UPDATE synthesis_campaigns")) {
          return rows({ ...SAMPLE_CAMPAIGN_ROW, status: "completed", outcome_summary: "all good" });
        }
        if (sql.includes("INSERT INTO synthesis_campaign_events")) {
          return rows();
        }
        return rows();
      },
    });

    const tool = buildRecordSynthesisCampaignOutcomeTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      status: "completed",
      outcome_summary: "all good",
      measurements: { final_yield_pct: 84 },
    });
    expect(out.campaign.status).toBe("completed");

    const eventCalls = dataSpy.mock.calls.filter(
      ([sql]) => (sql as string).includes("INSERT INTO synthesis_campaign_events"),
    );
    const eventTypes = eventCalls
      .map(([sql, params]) => {
        const s = sql as string;
        const p = params as unknown[];
        // record_synthesis_campaign_outcome uses two distinct INSERT shapes:
        //   1) (campaign_id, event_type, payload) for the status-close event ($2 = type)
        //   2) (campaign_id, event_type='measurement_recorded', payload) for the measurement event
        if (s.includes("'measurement_recorded'")) return "measurement_recorded";
        return p[1];
      });
    expect(eventTypes).toContain("campaign_completed");
    expect(eventTypes).toContain("measurement_recorded");
  });

  it("emits campaign_aborted on aborted/failed/died statuses", async () => {
    const events: string[] = [];
    const { pool } = createMockPool({
      dataHandler: async (sql, params) => {
        if (sql.includes("UPDATE synthesis_campaigns")) {
          return rows({ ...SAMPLE_CAMPAIGN_ROW, status: "aborted", outcome_summary: "user request" });
        }
        if (sql.includes("INSERT INTO synthesis_campaign_events")) {
          const eventType = params?.[1];
          events.push(typeof eventType === "string" ? eventType : "");
          return rows();
        }
        return rows();
      },
    });
    const tool = buildRecordSynthesisCampaignOutcomeTool(pool);
    await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_UUID,
      status: "aborted",
      outcome_summary: "user request",
    });
    expect(events).toContain("campaign_aborted");
  });
});

// ---------------------------------------------------------------------------
// Smoke: PLAYBOOK constants are non-empty for every kind
// ---------------------------------------------------------------------------
describe("PLAYBOOK", () => {
  it("has non-empty playbook for each campaign kind", () => {
    for (const kind of [
      "single_experiment",
      "library_synthesis",
      "screening",
      "bo_campaign",
      "bo_or_die",
    ] as const) {
      expect(PLAYBOOK[kind].length).toBeGreaterThan(0);
    }
  });
  it("bo_or_die includes a die_check step", () => {
    expect(PLAYBOOK.bo_or_die).toContain("die_check");
  });
});

// silence unused-import lint
void vi;
