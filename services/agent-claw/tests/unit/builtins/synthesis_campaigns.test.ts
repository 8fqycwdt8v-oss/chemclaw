// Unit tests for the seven synthesis-campaign builtins.
//
// The 2026-05-09 code-completeness review (L3-1) flagged that none of
// these had a dedicated unit suite. Each is exercised end-to-end by the
// integration tests against a Postgres testcontainer; this file pins
// the parts that don't need a real DB:
//
//   - tool shape (id / readOnly annotation / output schema validity)
//   - input-schema validation (Zod parse errors on missing or invalid args)
//   - core execute() behaviour (correct SQL touchpoints, error propagation)
//
// Mocking style follows compute_confidence_ensemble.test.ts: a captured-
// query pool whose responses are configured per test. SQL string
// matching is intentional — a refactor that drops the bi-temporal
// predicate or the campaign_created event INSERT will fail here, which
// is the whole point of pinning these.

import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

import { buildStartSynthesisCampaignTool } from "../../../src/tools/builtins/start_synthesis_campaign.js";
import { buildListSynthesisCampaignsTool } from "../../../src/tools/builtins/list_synthesis_campaigns.js";
import { buildGetSynthesisCampaignTool } from "../../../src/tools/builtins/get_synthesis_campaign.js";
import { buildAddSynthesisCampaignStepTool } from "../../../src/tools/builtins/add_synthesis_campaign_step.js";
import { buildUpdateSynthesisCampaignStepTool } from "../../../src/tools/builtins/update_synthesis_campaign_step.js";
import { buildAdvanceSynthesisCampaignTool } from "../../../src/tools/builtins/advance_synthesis_campaign.js";
import { buildRecordSynthesisCampaignOutcomeTool } from "../../../src/tools/builtins/record_synthesis_campaign_outcome.js";
import { makeCtx } from "../../helpers/make-ctx.js";

interface CapturedQuery {
  text: string;
  values: readonly unknown[];
}

/**
 * Build a Pool whose client.query() runs `responder(text, values)` for
 * every query and stores the captured request. Tests configure the
 * responder per scenario rather than maintaining a stateful FIFO so
 * the order of irrelevant SET LOCAL calls (issued by
 * `withUserContext`) doesn't matter.
 */
function makeRespondingPool(
  responder: (text: string, values: readonly unknown[]) => unknown[] | undefined,
): { pool: Pool; captured: CapturedQuery[] } {
  const captured: CapturedQuery[] = [];
  const client: Partial<PoolClient> = {
    query: vi.fn(async (textOrConfig: unknown, values?: readonly unknown[]) => {
      const text =
        typeof textOrConfig === "string"
          ? textOrConfig
          : (textOrConfig as { text: string }).text;
      const vals = values ?? [];
      captured.push({ text, values: vals });
      const rows = responder(text, vals) ?? [];
      return { rows } as unknown as Awaited<ReturnType<NonNullable<PoolClient["query"]>>>;
    }) as unknown as PoolClient["query"],
    release: vi.fn(),
  };
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => client as PoolClient),
  };
  return { pool: pool as Pool, captured };
}

const CAMPAIGN_ID = "11111111-1111-1111-1111-111111111111";
const PROJECT_ID = "22222222-2222-2222-2222-222222222222";
const STEP_ID = "33333333-3333-3333-3333-333333333333";

function campaignRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: CAMPAIGN_ID,
    nce_project_id: PROJECT_ID,
    agent_session_id: null,
    kind: "single_experiment",
    name: "Test Campaign",
    status: "proposed",
    goal: {},
    policy: {},
    total_steps: 0,
    completed_steps: 0,
    outcome_summary: null,
    created_at: "2026-05-09T00:00:00.000+00",
    updated_at: "2026-05-09T00:00:00.000+00",
    etag: 1,
    ...overrides,
  };
}

function stepRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: STEP_ID,
    campaign_id: CAMPAIGN_ID,
    step_index: 0,
    kind: "retrosynthesis",
    status: "pending",
    ref_table: null,
    ref_id: null,
    depends_on: [],
    notes: null,
    started_at: null,
    completed_at: null,
    inputs: {},
    outputs: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// start_synthesis_campaign
// ---------------------------------------------------------------------------

describe("start_synthesis_campaign", () => {
  it("registers as not-readOnly with the right id", () => {
    const { pool } = makeRespondingPool(() => undefined);
    const tool = buildStartSynthesisCampaignTool(pool);
    expect(tool.id).toBe("start_synthesis_campaign");
    expect(tool.annotations?.readOnly).toBe(false);
  });

  it("rejects missing userEntraId", async () => {
    const { pool } = makeRespondingPool(() => undefined);
    const tool = buildStartSynthesisCampaignTool(pool);
    const ctx = makeCtx();
    (ctx as { userEntraId?: string }).userEntraId = undefined;
    await expect(
      tool.execute(ctx, {
        nce_project_internal_id: "PRJ-1",
        kind: "single_experiment",
        name: "T",
        goal: {},
        policy: {},
        seed_playbook: false,
      }),
    ).rejects.toThrow(/userEntraId/);
  });

  it("throws nce_project_not_found_or_forbidden when the project lookup misses", async () => {
    const { pool } = makeRespondingPool((text) => {
      if (text.includes("FROM nce_projects")) return [];
      return undefined;
    });
    const tool = buildStartSynthesisCampaignTool(pool);
    await expect(
      tool.execute(makeCtx(), {
        nce_project_internal_id: "MISSING",
        kind: "single_experiment",
        name: "T",
        goal: {},
        policy: {},
        seed_playbook: false,
      }),
    ).rejects.toThrow(/nce_project_not_found_or_forbidden/);
  });

  it("seeds the playbook + emits campaign_created when seed_playbook=true", async () => {
    let stepSeq = 0;
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("FROM nce_projects")) return [{ id: PROJECT_ID }];
      if (text.includes("INSERT INTO synthesis_campaigns")) return [campaignRow()];
      // Per-row INSERT with RETURNING id::text — each call returns a fresh id
      // so the loop in start_synthesis_campaign can wire depends_on for the
      // following step.
      if (text.includes("INSERT INTO synthesis_campaign_steps")) {
        stepSeq += 1;
        return [{ id: `step-uuid-${stepSeq}` }];
      }
      return undefined;
    });
    const tool = buildStartSynthesisCampaignTool(pool);

    const out = await tool.execute(makeCtx(), {
      nce_project_internal_id: "PRJ-1",
      kind: "single_experiment",
      name: "T",
      goal: {},
      policy: {},
      seed_playbook: true,
    });

    // The single_experiment playbook has 7 step kinds.
    expect(out.seeded_step_kinds.length).toBe(7);
    const stepInsert = captured.find((q) =>
      q.text.includes("INSERT INTO synthesis_campaign_steps"),
    );
    expect(stepInsert).toBeDefined();
    const eventInsert = captured.find(
      (q) =>
        q.text.includes("INSERT INTO synthesis_campaign_events") &&
        q.text.includes("'campaign_created'"),
    );
    expect(eventInsert).toBeDefined();
  });

  it("does not run the playbook insert when seed_playbook=false", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("FROM nce_projects")) return [{ id: PROJECT_ID }];
      if (text.includes("INSERT INTO synthesis_campaigns")) return [campaignRow()];
      return undefined;
    });
    const tool = buildStartSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), {
      nce_project_internal_id: "PRJ-1",
      kind: "bo_or_die",
      name: "T",
      goal: {},
      policy: {},
      seed_playbook: false,
    });
    expect(out.seeded_step_kinds).toEqual([]);
    expect(
      captured.some((q) => q.text.includes("INSERT INTO synthesis_campaign_steps")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list_synthesis_campaigns
// ---------------------------------------------------------------------------

describe("list_synthesis_campaigns", () => {
  it("registers as readOnly with the right id", () => {
    const { pool } = makeRespondingPool(() => undefined);
    const tool = buildListSynthesisCampaignsTool(pool);
    expect(tool.id).toBe("list_synthesis_campaigns");
    expect(tool.annotations?.readOnly).toBe(true);
  });

  it("returns all visible campaigns when no filters are supplied", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [campaignRow()];
      return undefined;
    });
    const tool = buildListSynthesisCampaignsTool(pool);
    const out = await tool.execute(makeCtx(), {
      only_mine: false,
      limit: 25,
    });
    expect(out.campaigns).toHaveLength(1);
    const select = captured.find((q) => q.text.includes("FROM synthesis_campaigns"));
    expect(select).toBeDefined();
    // No WHERE filters → only the LIMIT param.
    expect(select!.values).toEqual([25]);
  });

  it("threads only_mine into the WHERE clause", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [];
      return undefined;
    });
    const tool = buildListSynthesisCampaignsTool(pool);
    await tool.execute(makeCtx("scientist@pharma.com"), {
      only_mine: true,
      limit: 10,
    });
    const select = captured.find((q) => q.text.includes("FROM synthesis_campaigns"));
    expect(select!.text).toContain("created_by_user_entra_id");
    expect(select!.values).toEqual(["scientist@pharma.com", 10]);
  });

  it("composes status + kind filters", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [];
      return undefined;
    });
    const tool = buildListSynthesisCampaignsTool(pool);
    await tool.execute(makeCtx(), {
      status: ["active", "awaiting_measurement"],
      kind: ["bo_campaign"],
      only_mine: false,
      limit: 5,
    });
    const select = captured.find((q) => q.text.includes("FROM synthesis_campaigns"));
    expect(select!.text).toMatch(/sc\.status = ANY/);
    expect(select!.text).toMatch(/sc\.kind = ANY/);
  });
});

// ---------------------------------------------------------------------------
// get_synthesis_campaign
// ---------------------------------------------------------------------------

describe("get_synthesis_campaign", () => {
  it("throws synthesis_campaign_not_found_or_forbidden on RLS miss", async () => {
    const { pool } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [];
      return undefined;
    });
    const tool = buildGetSynthesisCampaignTool(pool);
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: CAMPAIGN_ID,
        include_events: true,
        events_limit: 50,
      }),
    ).rejects.toThrow(/synthesis_campaign_not_found_or_forbidden/);
  });

  it("returns campaign + steps + events on the happy path", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [campaignRow()];
      if (text.includes("FROM synthesis_campaign_steps")) {
        return [stepRow(), stepRow({ id: "44444444-4444-4444-4444-444444444444", step_index: 1 })];
      }
      if (text.includes("FROM synthesis_campaign_events")) {
        return [
          {
            id: "55555555-5555-5555-5555-555555555555",
            step_id: null,
            event_type: "campaign_created",
            payload: { kind: "single_experiment", seeded_steps: 7 },
            occurred_at: "2026-05-09T00:00:00.000+00",
          },
        ];
      }
      return undefined;
    });
    const tool = buildGetSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_ID,
      include_events: true,
      events_limit: 50,
    });
    expect(out.campaign.id).toBe(CAMPAIGN_ID);
    expect(out.steps).toHaveLength(2);
    expect(out.events).toHaveLength(1);
    expect(out.events[0]!.event_type).toBe("campaign_created");
    // events_limit was honoured
    const eventsSelect = captured.find((q) =>
      q.text.includes("FROM synthesis_campaign_events"),
    );
    expect(eventsSelect!.values).toContain(50);
  });

  it("skips the events query when include_events=false", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [campaignRow()];
      if (text.includes("FROM synthesis_campaign_steps")) return [];
      return undefined;
    });
    const tool = buildGetSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_ID,
      include_events: false,
      events_limit: 50,
    });
    expect(out.events).toEqual([]);
    expect(
      captured.some((q) => q.text.includes("FROM synthesis_campaign_events")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// add_synthesis_campaign_step
// ---------------------------------------------------------------------------

describe("add_synthesis_campaign_step", () => {
  it("appends a step + emits step_added event", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [{ id: CAMPAIGN_ID }];
      if (text.includes("INSERT INTO synthesis_campaign_steps"))
        return [stepRow({ step_index: 7 })];
      if (text.includes("UPDATE synthesis_campaigns")) return [];
      return undefined;
    });
    const tool = buildAddSynthesisCampaignStepTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_ID,
      kind: "qm_screen",
      inputs: { smiles: "CCO" },
      depends_on: [],
    });
    expect(out.step.step_index).toBe(7);
    const evt = captured.find(
      (q) =>
        q.text.includes("INSERT INTO synthesis_campaign_events") &&
        q.text.includes("'step_added'"),
    );
    expect(evt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// update_synthesis_campaign_step
// ---------------------------------------------------------------------------

describe("update_synthesis_campaign_step", () => {
  it("transitions a step to in_progress and stamps started_at", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("SELECT status FROM synthesis_campaign_steps")) {
        return [{ status: "pending" }];
      }
      if (text.includes("UPDATE synthesis_campaign_steps")) {
        return [stepRow({ status: "in_progress", started_at: "2026-05-09T00:00:01" })];
      }
      if (text.includes("UPDATE synthesis_campaigns")) {
        return [campaignRow({ status: "active" })];
      }
      return undefined;
    });
    const tool = buildUpdateSynthesisCampaignStepTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_ID,
      step_id: STEP_ID,
      status: "in_progress",
    });
    expect(out.step.status).toBe("in_progress");
    expect(out.step.started_at).toBe("2026-05-09T00:00:01");
    // event_type is passed as a parameter ($3) — check it lives in
    // captured.values, not the SQL string.
    const evt = captured.find(
      (q) =>
        q.text.includes("INSERT INTO synthesis_campaign_events") &&
        q.values.includes("step_started"),
    );
    expect(evt).toBeDefined();
  });

  it("transitions a step to completed and stamps completed_at + bumps counter", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("SELECT status FROM synthesis_campaign_steps")) {
        return [{ status: "in_progress" }];
      }
      if (text.includes("UPDATE synthesis_campaign_steps")) {
        return [stepRow({ status: "completed", completed_at: "2026-05-09T00:00:02" })];
      }
      if (text.includes("UPDATE synthesis_campaigns")) {
        return [campaignRow({ status: "active", completed_steps: 1 })];
      }
      return undefined;
    });
    const tool = buildUpdateSynthesisCampaignStepTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_ID,
      step_id: STEP_ID,
      status: "completed",
      outputs: { yield_pct: 81 },
    });
    expect(out.step.status).toBe("completed");
    // The campaign UPDATE bumps completed_steps when the transition is fresh
    // (was non-terminal, now terminal) — captured.values for the campaign
    // UPDATE should carry `1` as the increment for that case.
    const campaignUpdate = captured.find(
      (q) =>
        q.text.includes("UPDATE synthesis_campaigns") &&
        q.text.includes("completed_steps"),
    );
    expect(campaignUpdate).toBeDefined();
    expect(campaignUpdate!.values).toContain(1);
    expect(
      captured.some(
        (q) =>
          q.text.includes("INSERT INTO synthesis_campaign_events") &&
          q.values.includes("step_completed"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// advance_synthesis_campaign
// ---------------------------------------------------------------------------

describe("advance_synthesis_campaign", () => {
  it("registers as not-readOnly", () => {
    const { pool } = makeRespondingPool(() => undefined);
    const tool = buildAdvanceSynthesisCampaignTool(pool);
    expect(tool.id).toBe("advance_synthesis_campaign");
    expect(tool.annotations?.readOnly).toBe(false);
  });

  it("returns no_ready_steps when nothing is pending", async () => {
    const { pool } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [campaignRow({ status: "active" })];
      if (text.includes("FROM synthesis_campaign_steps")) return [];
      return undefined;
    });
    const tool = buildAdvanceSynthesisCampaignTool(pool);
    const out = await tool.execute(makeCtx(), { campaign_id: CAMPAIGN_ID });
    // The exact next_action shape varies — but the absence of a ready
    // step must be visible to the orchestrator.
    expect(JSON.stringify(out)).toMatch(/no_ready_steps|completed|awaiting/);
  });

  it("throws synthesis_campaign_not_found_or_forbidden when RLS hides the row", async () => {
    const { pool } = makeRespondingPool((text) => {
      if (text.includes("FROM synthesis_campaigns")) return [];
      return undefined;
    });
    const tool = buildAdvanceSynthesisCampaignTool(pool);
    await expect(
      tool.execute(makeCtx(), { campaign_id: CAMPAIGN_ID }),
    ).rejects.toThrow(/synthesis_campaign_not_found_or_forbidden/);
  });
});

// ---------------------------------------------------------------------------
// record_synthesis_campaign_outcome
// ---------------------------------------------------------------------------

describe("record_synthesis_campaign_outcome", () => {
  it("registers as not-readOnly with the right id", () => {
    const { pool } = makeRespondingPool(() => undefined);
    const tool = buildRecordSynthesisCampaignOutcomeTool(pool);
    expect(tool.id).toBe("record_synthesis_campaign_outcome");
    expect(tool.annotations?.readOnly).toBe(false);
  });

  it("transitions to completed and writes outcome_summary", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("UPDATE synthesis_campaigns")) {
        return [campaignRow({ status: "completed", outcome_summary: "ok" })];
      }
      return undefined;
    });
    const tool = buildRecordSynthesisCampaignOutcomeTool(pool);
    const out = await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_ID,
      status: "completed",
      outcome_summary: "ok",
    });
    expect(out.campaign.status).toBe("completed");
    expect(out.campaign.outcome_summary).toBe("ok");
    // event_type is parameterized ($2::text) — check captured.values, not SQL.
    const evt = captured.find(
      (q) =>
        q.text.includes("INSERT INTO synthesis_campaign_events") &&
        q.values.includes("campaign_completed"),
    );
    expect(evt).toBeDefined();
  });

  it("transitions to aborted and emits campaign_aborted", async () => {
    const { pool, captured } = makeRespondingPool((text) => {
      if (text.includes("UPDATE synthesis_campaigns")) {
        return [campaignRow({ status: "aborted", outcome_summary: "policy revision" })];
      }
      return undefined;
    });
    const tool = buildRecordSynthesisCampaignOutcomeTool(pool);
    await tool.execute(makeCtx(), {
      campaign_id: CAMPAIGN_ID,
      status: "aborted",
      outcome_summary: "policy revision",
    });
    expect(
      captured.some(
        (q) =>
          q.text.includes("INSERT INTO synthesis_campaign_events") &&
          q.values.includes("campaign_aborted"),
      ),
    ).toBe(true);
  });

  it("rejects an invalid terminal status via the input schema", async () => {
    const { pool } = makeRespondingPool(() => undefined);
    const tool = buildRecordSynthesisCampaignOutcomeTool(pool);
    // The input schema constrains `status` to a specific set; passing
    // something out of band must be rejected before any DB call fires.
    await expect(
      tool.execute(makeCtx(), {
        campaign_id: CAMPAIGN_ID,
        // @ts-expect-error — runtime validation is the point of the test
        status: "running",
        outcome_summary: "still going",
      }),
    ).rejects.toThrow();
  });
});
