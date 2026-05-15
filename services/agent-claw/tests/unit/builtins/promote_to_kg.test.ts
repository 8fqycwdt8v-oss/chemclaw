// Tests for buildPromoteToKgTool — Universal Knowledge Accumulation Phase 0.
//
// The promote_to_kg builtin lets the agent push a reasoning conclusion or
// otherwise-unstructured piece of knowledge into the canonical `facts`
// table. Class is restricted to INTERPRETED / HYPOTHESIZED / ABSTRACTED
// (the deterministic-extractor classes OBSERVED / COMPUTED are reserved
// for projectors). Confidence is capped per class.

import { describe, it, expect } from "vitest";
import { buildPromoteToKgTool } from "../../../src/tools/builtins/promote_to_kg.js";
import { mockPool } from "../../helpers/mock-pg.js";
import { makeCtx } from "../../helpers/make-ctx.js";

const FACT_UUID = "00000000-0000-0000-0000-000000000123";
const PARENT_FACT_UUID = "aaaaaaaa-1111-2222-3333-444444444444";

function pushHappyPath(client: ReturnType<typeof mockPool>["client"]): void {
  // withUserContext wraps the body in BEGIN / set_config / ... / COMMIT.
  // Tool body issues two queries (INSERT facts → INSERT ingestion_events).
  client.queryResults.push(
    { rows: [], rowCount: 0 }, // BEGIN
    { rows: [], rowCount: 0 }, // set_config
    { rows: [{ id: FACT_UUID }], rowCount: 1 }, // INSERT INTO facts
    { rows: [], rowCount: 0 }, // INSERT INTO ingestion_events
    { rows: [], rowCount: 0 }, // COMMIT
  );
}

describe("buildPromoteToKgTool — happy path", () => {
  it("inserts an INTERPRETED fact and emits extracted_fact", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    const result = await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "INCHI=ABC",
      predicate: "agent_concluded_property",
      object_value: { property: "soluble_in_DMSO", verdict: true },
      confidence: 0.85,
      derivation_class: "INTERPRETED",
    });

    expect(result.fact_id).toBe(FACT_UUID);
    expect(result.confidence_tier).toBe("high");

    // Confirm both statements landed.
    const sqlTexts = client.querySpy.mock.calls.map((args) => {
      const first = args[0];
      return typeof first === "string" ? first : (first as { text: string }).text;
    });
    expect(sqlTexts.some((t) => t.includes("INSERT INTO facts"))).toBe(true);
    expect(sqlTexts.some((t) => t.includes("INSERT INTO ingestion_events"))).toBe(true);
  });

  it("stamps extractor_name='promote_to_kg' and source_table='agent_promotion'", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "p",
      object_value: {},
      confidence: 0.8,
      derivation_class: "INTERPRETED",
    });

    // Find the INSERT INTO facts call and inspect its parameters.
    const factsCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO facts");
    });
    expect(factsCall).toBeDefined();
    const factsSql =
      typeof factsCall![0] === "string"
        ? factsCall![0]
        : (factsCall![0] as { text: string }).text;
    expect(factsSql).toContain("'agent_promotion'");
    expect(factsSql).toContain("'promote_to_kg'");
  });

  it("emits extracted_fact ingestion event referencing the new fact_id", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "p",
      object_value: {},
      confidence: 0.8,
      derivation_class: "INTERPRETED",
    });

    const eventCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO ingestion_events");
    });
    expect(eventCall).toBeDefined();
    const eventSql =
      typeof eventCall![0] === "string"
        ? eventCall![0]
        : (eventCall![0] as { text: string }).text;
    expect(eventSql).toContain("'extracted_fact'");
    expect(eventSql).toContain("'facts'");
    // Bound param array carries the fact_id, derivation_class, predicate.
    const params = eventCall![1] as unknown[];
    expect(params).toContain(FACT_UUID);
    expect(params).toContain("INTERPRETED");
  });
});

describe("buildPromoteToKgTool — class restriction", () => {
  it("rejects derivation_class=OBSERVED via schema (not allowed enum value)", async () => {
    const { pool } = mockPool();
    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await expect(
      tool.execute(ctx, {
        subject_label: "Compound",
        subject_id_value: "ABC",
        predicate: "x",
        object_value: {},
        confidence: 0.9,
        derivation_class: "OBSERVED",
      } as unknown as Parameters<typeof tool.execute>[1]),
    ).rejects.toThrow();
  });

  it("rejects derivation_class=COMPUTED via schema", async () => {
    const { pool } = mockPool();
    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await expect(
      tool.execute(ctx, {
        subject_label: "Compound",
        subject_id_value: "ABC",
        predicate: "x",
        object_value: {},
        confidence: 0.7,
        derivation_class: "COMPUTED",
      } as unknown as Parameters<typeof tool.execute>[1]),
    ).rejects.toThrow();
  });
});

describe("buildPromoteToKgTool — confidence caps", () => {
  it("rejects confidence > INTERPRETED cap (0.95)", async () => {
    const { pool } = mockPool();
    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await expect(
      tool.execute(ctx, {
        subject_label: "Compound",
        subject_id_value: "ABC",
        predicate: "x",
        object_value: {},
        confidence: 0.99,
        derivation_class: "INTERPRETED",
      }),
    ).rejects.toThrow(/confidence/i);
  });

  it("rejects confidence > HYPOTHESIZED cap (0.80)", async () => {
    const { pool } = mockPool();
    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await expect(
      tool.execute(ctx, {
        subject_label: "Compound",
        subject_id_value: "ABC",
        predicate: "x",
        object_value: {},
        confidence: 0.81,
        derivation_class: "HYPOTHESIZED",
      }),
    ).rejects.toThrow(/confidence/i);
  });

  it("rejects confidence > ABSTRACTED cap (0.70)", async () => {
    const { pool } = mockPool();
    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await expect(
      tool.execute(ctx, {
        subject_label: "Compound",
        subject_id_value: "ABC",
        predicate: "x",
        object_value: {},
        confidence: 0.71,
        derivation_class: "ABSTRACTED",
      }),
    ).rejects.toThrow(/confidence/i);
  });

  it("accepts confidence == HYPOTHESIZED cap (0.80) — boundary inclusive", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    const result = await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "ABC",
      predicate: "x",
      object_value: {},
      confidence: 0.8,
      derivation_class: "HYPOTHESIZED",
    });
    expect(result.fact_id).toBe(FACT_UUID);
  });
});

describe("buildPromoteToKgTool — schema validation", () => {
  it("inputSchema rejects empty subject_id_value", () => {
    const { pool } = mockPool();
    const tool = buildPromoteToKgTool(pool);
    const r = tool.inputSchema.safeParse({
      subject_label: "Compound",
      subject_id_value: "",
      predicate: "x",
      object_value: {},
      confidence: 0.8,
      derivation_class: "INTERPRETED",
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects empty predicate", () => {
    const { pool } = mockPool();
    const tool = buildPromoteToKgTool(pool);
    const r = tool.inputSchema.safeParse({
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "",
      object_value: {},
      confidence: 0.8,
      derivation_class: "INTERPRETED",
    });
    expect(r.success).toBe(false);
  });

  it("inputSchema rejects confidence outside [0,1]", () => {
    const { pool } = mockPool();
    const tool = buildPromoteToKgTool(pool);
    const r = tool.inputSchema.safeParse({
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "p",
      object_value: {},
      confidence: 1.5,
      derivation_class: "INTERPRETED",
    });
    expect(r.success).toBe(false);
  });
});

describe("buildPromoteToKgTool — tier derivation + parent linkage", () => {
  it("derives confidence_tier='high' for confidence>=0.85", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "p",
      object_value: {},
      confidence: 0.85,
      derivation_class: "INTERPRETED",
    });

    const factsCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO facts");
    });
    expect(factsCall).toBeDefined();
    const params = factsCall![1] as unknown[];
    expect(params).toContain("high");
  });

  it("derives confidence_tier='low' for confidence in [0.40, 0.65)", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "p",
      object_value: {},
      confidence: 0.5,
      derivation_class: "ABSTRACTED",
    });

    const factsCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO facts");
    });
    const params = factsCall![1] as unknown[];
    expect(params).toContain("low");
  });

  it("derives confidence_tier='exploratory' for confidence<0.40", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "p",
      object_value: {},
      confidence: 0.3,
      derivation_class: "ABSTRACTED",
    });

    const factsCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO facts");
    });
    const params = factsCall![1] as unknown[];
    expect(params).toContain("exploratory");
  });

  it("sets derivation_depth=1 when source_fact_ids is non-empty", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "p",
      object_value: {},
      confidence: 0.7,
      derivation_class: "INTERPRETED",
      source_fact_ids: [PARENT_FACT_UUID],
    });

    const factsCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO facts");
    });
    const params = factsCall![1] as unknown[];
    // derivation_depth=1 (parent referenced) AND source_fact_ids array passed.
    expect(params).toContain(1);
    expect(params).toContainEqual([PARENT_FACT_UUID]);
  });

  it("sets derivation_depth=0 when source_fact_ids is empty/omitted", async () => {
    const { pool, client } = mockPool();
    pushHappyPath(client);

    const tool = buildPromoteToKgTool(pool);
    const ctx = makeCtx("scientist@pharma.com");

    await tool.execute(ctx, {
      subject_label: "Compound",
      subject_id_value: "X",
      predicate: "p",
      object_value: {},
      confidence: 0.7,
      derivation_class: "INTERPRETED",
    });

    const factsCall = client.querySpy.mock.calls.find((args) => {
      const first = args[0];
      const text =
        typeof first === "string" ? first : (first as { text: string }).text;
      return text.includes("INSERT INTO facts");
    });
    const params = factsCall![1] as unknown[];
    expect(params).toContain(0);
  });
});
