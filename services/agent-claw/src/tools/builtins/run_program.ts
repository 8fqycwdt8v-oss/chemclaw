// run_program — programmatic tool calling via E2B sandbox (Phase D.1).
//
// The agent can execute Python code inside an isolated E2B sandbox that has
// access to a typed ChemClaw stub library exposing our MCP services.
//
// Security constraints:
//   - Code is max 50_000 chars.
//   - Net egress from the sandbox is disabled unless cfg.SANDBOX_ALLOW_NET_EGRESS.
//   - Per-execution CPU cap: SANDBOX_MAX_CPU_S seconds.
//   - `reason` field is mandatory for audit.
//   - Pre-flight check: code must not reference un-stubbed helpers.
//
// Stub library:
//   At first call the tool generates /sandbox/chemclaw/__init__.py from the live
//   MCP service catalog. Helpers: fetch_document, query_kg, find_similar_reactions,
//   canonicalize_smiles, embed_text, compute_drfp.
//   Each helper POSTs to the right MCP endpoint (cluster-network URLs from mcp_tools table).
//
// Output convention:
//   The generated code must print JSON with the key "__chemclaw_output__" containing
//   a dict of expected_outputs variable names -> values:
//     import json; print(json.dumps({"__chemclaw_output__": {"my_var": my_var}}))
//   The tool parses this line and returns it as the `outputs` field.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import type { SandboxClient } from "../../core/sandbox.js";
// Citation subset used by run_program — only kg_fact and external_url are applicable
// since the sandbox produces computed results, not document retrieval.
interface RunProgramCitation {
  source_id: string;
  source_kind: "kg_fact" | "external_url";
  source_uri?: string;
  snippet?: string;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const RunProgramIn = z.object({
  python_code: z
    .string()
    .min(1, "python_code must be non-empty")
    .max(50_000, "python_code must not exceed 50,000 characters"),
  inputs: z.record(z.unknown()).default({}),
  expected_outputs: z
    .array(z.string().min(1).max(128))
    .min(1, "expected_outputs must list at least one variable name")
    .max(50),
  reason: z.string().min(1, "reason is required for audit").max(1000),
  timeout_ms: z.number().int().min(1000).max(30_000).optional(),
});
export type RunProgramInput = z.infer<typeof RunProgramIn>;

export const RunProgramOut = z.object({
  outputs: z.record(z.unknown()),
  stdout: z.string(),
  stderr: z.string(),
  duration_ms: z.number(),
  citation: z
    .object({
      source_id: z.string(),
      source_kind: z.enum(["kg_fact", "external_url"]),
      source_uri: z.string().optional(),
      snippet: z.string().optional(),
    })
    .optional(),
});
export type RunProgramOutput = z.infer<typeof RunProgramOut>;

// ---------------------------------------------------------------------------
// MCP stub library — known helper names (pre-flight guard).
// ---------------------------------------------------------------------------

const KNOWN_HELPERS = new Set([
  "fetch_document",
  "query_kg",
  "find_similar_reactions",
  "canonicalize_smiles",
  "embed_text",
  "compute_drfp",
]);

// ---------------------------------------------------------------------------
// MCP URL row shape from the database.
// ---------------------------------------------------------------------------

interface McpToolRow {
  service_name: string;
  base_url: string;
}

// ---------------------------------------------------------------------------
// Stub library generator — builds the chemclaw Python stub.
// Called once per process; result is cached.
// ---------------------------------------------------------------------------

let _stubCache: string | null = null;

export function buildStubLibrary(mcpUrls: Record<string, string>): string {
  const rdkitUrl = mcpUrls["mcp-rdkit"] ?? "http://localhost:8001";
  const drfpUrl = mcpUrls["mcp-drfp"] ?? "http://localhost:8002";
  const kgUrl = mcpUrls["mcp-kg"] ?? "http://localhost:8003";
  const embedderUrl = mcpUrls["mcp-embedder"] ?? "http://localhost:8004";
  const docFetcherUrl = mcpUrls["mcp-doc-fetcher"] ?? "http://localhost:8006";

  return `"""chemclaw -- auto-generated stub library for E2B programmatic tool calls.
Generated at agent startup. Do not edit manually.
"""
import json
import urllib.request

def _post(url, body):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def fetch_document(document_id, format="markdown", pages=None):
    """Fetch a document by ID. format: 'markdown' | 'bytes' | 'pdf_pages'."""
    body = {"document_id": document_id, "format": format}
    if pages is not None:
        body["pages"] = pages
    return _post("${docFetcherUrl}/fetch", body)

def query_kg(query, valid_at=None, limit=10):
    """Query the bi-temporal knowledge graph."""
    body = {"query": query, "limit": limit}
    if valid_at:
        body["valid_at"] = valid_at
    return _post("${kgUrl}/query", body)

def find_similar_reactions(rxn_smiles, k=10, rxno_class=None, min_yield_pct=None):
    """Find similar reactions by DRFP fingerprint."""
    body = {"rxn_smiles": rxn_smiles, "k": k}
    if rxno_class:
        body["rxno_class"] = rxno_class
    if min_yield_pct is not None:
        body["min_yield_pct"] = min_yield_pct
    return _post("${drfpUrl}/similar_reactions", body)

def canonicalize_smiles(smiles, kekulize=False):
    """Canonicalize a SMILES string via RDKit."""
    return _post("${rdkitUrl}/tools/canonicalize_smiles", {"smiles": smiles, "kekulize": kekulize})

def embed_text(text):
    """Generate a BGE-M3 embedding for the given text."""
    return _post("${embedderUrl}/embed", {"text": text})

def compute_drfp(rxn_smiles):
    """Compute a DRFP fingerprint vector for a reaction SMILES."""
    return _post("${drfpUrl}/encode", {"rxn_smiles": rxn_smiles})
`;
}

// ---------------------------------------------------------------------------
// Pre-flight check -- scan code for calls to unknown chemclaw.* helpers.
// ---------------------------------------------------------------------------

const CHEMCLAW_CALL_RE = /\bchemclaw\.(\w+)\s*\(/g;

export function preflightCheck(code: string): { ok: boolean; unknownHelpers: string[] } {
  const unknown: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = CHEMCLAW_CALL_RE.exec(code)) !== null) {
    const name = match[1];
    if (name && !KNOWN_HELPERS.has(name)) {
      unknown.push(name);
    }
  }
  return { ok: unknown.length === 0, unknownHelpers: unknown };
}

// ---------------------------------------------------------------------------
// Output parser -- extracts the __chemclaw_output__ dict from stdout.
// ---------------------------------------------------------------------------

export function parseOutputs(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes('"__chemclaw_output__"')) {
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        const out = parsed.__chemclaw_output__;
        if (out && typeof out === "object" && !Array.isArray(out)) {
          return out as Record<string, unknown>;
        }
      } catch {
        // Not valid JSON on this line -- continue scanning.
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wrapper code generator -- wraps user code to inject inputs + collect outputs.
// ---------------------------------------------------------------------------

export function wrapCode(
  userCode: string,
  inputs: Record<string, unknown>,
  expectedOutputs: string[],
): string {
  const inputsJson = JSON.stringify(inputs);
  const outputsJson = JSON.stringify(expectedOutputs);

  return `import json as _json
import sys as _sys

# Inject inputs as globals.
_inputs = ${inputsJson}
for _k, _v in _inputs.items():
    globals()[_k] = _v

# ---- User code ----
${userCode}
# ---- End user code ----

# Collect expected outputs.
_expected = ${outputsJson}
_result = {}
for _name in _expected:
    if _name in globals():
        _result[_name] = globals().get(_name)
    else:
        _result[_name] = None

print(_json.dumps({"__chemclaw_output__": _result}), file=_sys.stdout)
`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function buildRunProgramTool(
  pool: Pool,
  sandboxClient: SandboxClient,
) {
  return defineTool({
    id: "run_program",
    description:
      "Execute Python code in an isolated E2B sandbox that has access to ChemClaw MCP helpers. " +
      "Specify the code, any named inputs, and the variable names you expect the program to populate. " +
      "Required: reason (free text for audit). " +
      "Available helpers: chemclaw.fetch_document, chemclaw.query_kg, chemclaw.find_similar_reactions, " +
      "chemclaw.canonicalize_smiles, chemclaw.embed_text, chemclaw.compute_drfp.",
    inputSchema: RunProgramIn,
    outputSchema: RunProgramOut,
    annotations: { readOnly: false },

    execute: async (_ctx, input) => {
      const { python_code, expected_outputs, timeout_ms } = input;
      const inputs: Record<string, unknown> = input.inputs ?? {};

      // Pre-flight check.
      const { ok, unknownHelpers } = preflightCheck(python_code);
      if (!ok) {
        throw new Error(
          `run_program: code references unknown chemclaw helpers: ${unknownHelpers.join(", ")}. ` +
            `Available helpers: ${[...KNOWN_HELPERS].join(", ")}`,
        );
      }

      // Load MCP URLs from DB (cached in stub).
      if (!_stubCache) {
        const { rows } = await pool.query<McpToolRow>(
          `SELECT service_name, base_url FROM mcp_tools WHERE enabled = true`,
        );
        const mcpUrls: Record<string, string> = {};
        for (const row of rows) {
          mcpUrls[row.service_name] = row.base_url;
        }
        _stubCache = buildStubLibrary(mcpUrls);
      }
      const stubCode = _stubCache;

      // Create sandbox.
      const handle = await sandboxClient.createSandbox();
      try {
        // Mount the chemclaw stub library.
        const stubBuf = Buffer.from(stubCode, "utf-8");
        await sandboxClient.mountReadOnlyFile(handle, stubBuf, "/sandbox/chemclaw/__init__.py");

        // Wrap user code to inject inputs + collect outputs.
        const wrappedCode = wrapCode(python_code, inputs, expected_outputs);

        // Execute.
        const result = await sandboxClient.executePython(
          handle,
          wrappedCode,
          {},
          undefined,
          timeout_ms ?? 30_000,
        );

        // Parse outputs.
        const outputs = parseOutputs(result.stdout) ?? {};

        // Best-effort citation: if output contains fact_id or url, surface it.
        let citation: RunProgramCitation | undefined;
        for (const v of Object.values(outputs)) {
          if (v && typeof v === "object") {
            const obj = v as Record<string, unknown>;
            if (typeof obj.fact_id === "string") {
              citation = {
                source_id: obj.fact_id,
                source_kind: "kg_fact",
              };
              break;
            }
            if (typeof obj.url === "string") {
              citation = {
                source_id: obj.url,
                source_kind: "external_url",
                source_uri: obj.url,
              };
              break;
            }
          }
        }

        return {
          outputs,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.duration_ms,
          citation,
        };
      } finally {
        await sandboxClient.closeSandbox(handle);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Exported for registry -- clears the stub cache (useful in tests / hot-reload).
// ---------------------------------------------------------------------------
export function clearStubCache(): void {
  _stubCache = null;
}
