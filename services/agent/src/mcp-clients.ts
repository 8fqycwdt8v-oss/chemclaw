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

export { UpstreamError };
