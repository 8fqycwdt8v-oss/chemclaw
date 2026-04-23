// Typed clients for our Python tool services.
//
// These are plain HTTP clients (REST-over-JSON). The "MCP" prefix refers to
// the architectural role, not the MCP wire protocol — sprint 3 adds the
// Streamable HTTP MCP transport; for now we keep things simple.
//
// Defenses applied at this boundary:
//   - explicit timeouts (AbortController) — no hanging calls
//   - input validation via Zod before leaving this process
//   - response validation via Zod before returning to the caller
//   - no retries here (retries belong in the caller's agent loop, where
//     budget and idempotency context are available)

import { z } from "zod";

// ---------- DRFP client -----------------------------------------------------

const ComputeDrfpIn = z.object({
  rxn_smiles: z.string().min(3).max(20_000),
  n_folded_length: z.number().int().min(512).max(4096).default(2048),
  radius: z.number().int().min(1).max(5).default(3),
});
export type ComputeDrfpInput = z.infer<typeof ComputeDrfpIn>;

const ComputeDrfpOut = z.object({
  n_bits: z.number().int().positive(),
  vector: z.array(z.number().int().min(0).max(1)),
  on_bit_count: z.number().int().nonnegative(),
});
export type ComputeDrfpOutput = z.infer<typeof ComputeDrfpOut>;

// ---------- RDKit client ----------------------------------------------------

const CanonicalizeIn = z.object({
  smiles: z.string().min(1).max(10_000),
  kekulize: z.boolean().optional(),
});
const CanonicalizeOut = z.object({
  canonical_smiles: z.string(),
  inchikey: z.string(),
  formula: z.string(),
  mw: z.number(),
});
export type CanonicalizeOutput = z.infer<typeof CanonicalizeOut>;

// ---------- KG client -------------------------------------------------------

const EntityRef = z.object({
  label: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Z][A-Za-z0-9_]*$/, "label must start uppercase and contain only [A-Za-z0-9_]"),
  id_property: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "id_property must be lowercase [a-z0-9_]"),
  id_value: z.string().min(1).max(4000),
});

const Predicate = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_]*$/, "predicate must be UPPER_SNAKE_CASE");

const QueryAtTimeIn = z.object({
  entity: EntityRef,
  predicate: Predicate.optional(),
  direction: z.enum(["in", "out", "both"]).default("both"),
  at_time: z.string().datetime({ offset: true }).optional(),
  include_invalidated: z.boolean().default(false),
});
export type QueryAtTimeInput = z.infer<typeof QueryAtTimeIn>;

const Provenance = z
  .object({
    source_type: z.enum([
      "ELN",
      "SOP",
      "literature",
      "analytical",
      "user_correction",
      "agent_inference",
      "import_tool",
    ]),
    source_id: z.string().min(1).max(4000),
  })
  .passthrough();

const QueriedFact = z.object({
  fact_id: z.string().uuid(),
  subject: EntityRef,
  predicate: Predicate,
  object: EntityRef,
  edge_properties: z.record(z.unknown()),
  confidence_tier: z.enum([
    "expert_validated",
    "multi_source_llm",
    "single_source_llm",
    "expert_disputed",
    "invalidated",
  ]),
  confidence_score: z.number(),
  t_valid_from: z.string(),
  t_valid_to: z.string().nullable(),
  recorded_at: z.string(),
  provenance: Provenance,
});

const QueryAtTimeOut = z.object({
  facts: z.array(QueriedFact),
});
export type QueryAtTimeOutput = z.infer<typeof QueryAtTimeOut>;

// ---------- Embedder client -------------------------------------------------

const EmbedTextIn = z.object({
  inputs: z.array(z.string().min(1).max(40_000)).min(1).max(128),
  normalize: z.boolean().default(true),
});
export type EmbedTextInput = z.infer<typeof EmbedTextIn>;

const EmbedTextOut = z.object({
  model: z.string(),
  dim: z.number().int().positive(),
  vectors: z.array(z.array(z.number())),
});
export type EmbedTextOutput = z.infer<typeof EmbedTextOut>;

// ---------- shared helpers --------------------------------------------------

class UpstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    public readonly detail: string,
  ) {
    super(`${service} returned ${status}: ${detail}`);
    this.name = "UpstreamError";
  }
}

async function postJson<TReq, TRes>(
  url: string,
  body: TReq,
  respSchema: z.ZodType<TRes>,
  timeoutMs: number,
  service: string,
): Promise<TRes> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      throw new UpstreamError(service, r.status, text.slice(0, 200));
    }
    const parsed = respSchema.safeParse(text.length ? JSON.parse(text) : null);
    if (!parsed.success) {
      throw new UpstreamError(
        service,
        502,
        `invalid response shape: ${parsed.error.issues[0]?.message ?? "?"}`,
      );
    }
    return parsed.data;
  } finally {
    clearTimeout(t);
  }
}

// ---------- public client classes -------------------------------------------

export class McpDrfpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 15_000,
  ) {}

  async computeDrfp(input: ComputeDrfpInput): Promise<ComputeDrfpOutput> {
    const validated = ComputeDrfpIn.parse(input);
    return postJson(
      `${this.baseUrl}/tools/compute_drfp`,
      validated,
      ComputeDrfpOut,
      this.timeoutMs,
      "mcp-drfp",
    );
  }
}

export class McpRdkitClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 10_000,
  ) {}

  async canonicalize(smiles: string, kekulize = false): Promise<CanonicalizeOutput> {
    const validated = CanonicalizeIn.parse({ smiles, kekulize });
    return postJson(
      `${this.baseUrl}/tools/canonicalize_smiles`,
      validated,
      CanonicalizeOut,
      this.timeoutMs,
      "mcp-rdkit",
    );
  }
}

export class McpKgClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 15_000,
  ) {}

  async queryAtTime(input: QueryAtTimeInput): Promise<QueryAtTimeOutput> {
    const validated = QueryAtTimeIn.parse(input);
    return postJson(
      `${this.baseUrl}/tools/query_at_time`,
      validated,
      QueryAtTimeOut,
      this.timeoutMs,
      "mcp-kg",
    );
  }
}

export class McpEmbedderClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 60_000,
  ) {}

  async embed(inputs: string[], normalize = true): Promise<EmbedTextOutput> {
    const validated = EmbedTextIn.parse({ inputs, normalize });
    return postJson(
      `${this.baseUrl}/tools/embed_text`,
      validated,
      EmbedTextOut,
      this.timeoutMs,
      "mcp-embedder",
    );
  }
}

// ---------- TabICL client ---------------------------------------------------

const FeaturizeIn = z.object({
  reaction_rows: z.array(
    z.object({
      reaction_id: z.string().min(1).max(64),
      rxn_smiles: z.string().min(3).max(20_000),
      rxno_class: z.string().max(200).nullable(),
      solvent: z.string().max(200).nullable(),
      temp_c: z.number().nullable(),
      time_min: z.number().nullable(),
      catalyst_loading_mol_pct: z.number().nullable(),
      base: z.string().max(200).nullable(),
      yield_pct: z.number().nullable(),
    }),
  ).min(1).max(1000),
  include_targets: z.boolean(),
});
export type FeaturizeInput = z.infer<typeof FeaturizeIn>;

const FeaturizeOut = z.object({
  feature_names: z.array(z.string()),
  categorical_names: z.array(z.string()),
  rows: z.array(z.array(z.any())),
  targets: z.array(z.number()).nullable(),
  skipped: z.array(z.object({
    reaction_id: z.string(),
    reason: z.string(),
  })),
});
export type FeaturizeOutput = z.infer<typeof FeaturizeOut>;

const PredictIn = z.object({
  support_rows: z.array(z.array(z.any())).min(1).max(1000),
  support_targets: z.array(z.number()).min(1).max(1000),
  query_rows: z.array(z.array(z.any())).min(1).max(1000),
  feature_names: z.array(z.string()).min(1).max(512),
  categorical_names: z.array(z.string()).max(512).default([]),
  task: z.enum(["regression", "classification"]),
  return_feature_importance: z.boolean().default(false),
});
export type PredictInput = z.infer<typeof PredictIn>;

const PredictOut = z.object({
  predictions: z.array(z.number()),
  prediction_std: z.array(z.number()),
  feature_importance: z.record(z.string(), z.number()).nullable(),
});
export type PredictOutput = z.infer<typeof PredictOut>;

export class McpTabiclClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 60_000,
  ) {}

  async featurize(input: FeaturizeInput): Promise<FeaturizeOutput> {
    const validated = FeaturizeIn.parse(input);
    return postJson(
      `${this.baseUrl}/featurize`,
      validated,
      FeaturizeOut,
      this.timeoutMs,
      "mcp-tabicl",
    );
  }

  async predictAndRank(input: PredictInput): Promise<PredictOutput> {
    const validated = PredictIn.parse(input);
    return postJson(
      `${this.baseUrl}/predict_and_rank`,
      validated,
      PredictOut,
      this.timeoutMs,
      "mcp-tabicl",
    );
  }
}

export { UpstreamError };
