// QM job cache — TS client for the `qm_jobs` table written by mcp-xtb / mcp-crest.
//
// The cache key is a 32-byte SHA-256 over the canonical method + input + params
// tuple. The Python helper at services/mcp_tools/common/qm_hash.py uses an
// identical formulation; cross-language parity is asserted by the integration
// test tests/integration/test_qm_hash_pact.py.
//
// Use this module from agent builtins (qm_*.ts) to:
//   - look up an existing successful QM result before issuing a fresh
//     network call to the MCP service, AND
//   - link the result row from session-level scratchpad / KG queries
//     without re-fetching the heavy payload.
//
// All reads are global (chemistry is tenant-agnostic), so we use
// `withSystemContext` rather than per-user RLS — but we still go through the
// typed pool so QM-cache bugs surface in the same observability pipeline as
// the rest of the agent.

import { createHash } from "node:crypto";
import { type Pool } from "pg";

import { getLogger } from "../observability/logger.js";
import { withSystemContext } from "./with-user-context.js";

const log = getLogger("agent-claw.qm-cache");

const CACHE_KEY_VERSION = "1"; // bump if canonicalization rules change

export type QmMethod =
  | "GFN0"
  | "GFN1"
  | "GFN2"
  | "GFN-FF"
  | "g-xTB"
  | "sTDA-xTB"
  | "IPEA-xTB"
  | "CREST";

export type QmTask =
  | "sp"
  | "opt"
  | "freq"
  | "ts"
  | "irc"
  | "scan"
  | "md"
  | "metad"
  | "solv_sp"
  | "pka"
  | "nci"
  | "nmr"
  | "exstates"
  | "fukui"
  | "charges"
  | "redox"
  | "conformers"
  | "tautomers"
  | "protomers";

export type QmSolventModel = "none" | "alpb" | "gbsa" | "cpcmx";

export interface QmCacheKeyInput {
  method: QmMethod;
  task: QmTask;
  smilesCanonical: string;
  charge?: number;
  multiplicity?: number;
  solventModel?: QmSolventModel;
  solventName?: string;
  params?: Record<string, unknown>;
}

export interface QmJobRow {
  id: string;
  status: string;
  method: string;
  task: string;
  smilesCanonical: string | null;
  energyHartree: number | null;
  converged: boolean | null;
  summaryMd: string | null;
  recordedAt: string;
}

/**
 * Compute the deterministic 32-byte SHA-256 cache key.
 * Mirrors services/mcp_tools/common/qm_hash.py:qm_cache_key.
 */
export function computeQmCacheKey(input: QmCacheKeyInput): Buffer {
  if (!input.method || !input.task) {
    throw new Error("method and task are required");
  }
  if (!input.smilesCanonical?.trim()) {
    throw new Error("smilesCanonical must be non-empty");
  }
  const multiplicity = input.multiplicity ?? 1;
  if (multiplicity < 1) {
    throw new Error("multiplicity must be >= 1");
  }
  const canonicalParams = canonicalJson(input.params ?? {});
  const parts = [
    CACHE_KEY_VERSION,
    input.method.toUpperCase(),
    input.task.toUpperCase(),
    input.smilesCanonical,
    String(Math.trunc(input.charge ?? 0)),
    String(Math.trunc(multiplicity)),
    (input.solventModel ?? "none").toLowerCase(),
    input.solventName ?? "",
    canonicalParams,
  ];
  const blob = parts.join("|");
  return createHash("sha256").update(blob, "utf8").digest();
}

/**
 * Look up an existing live (`valid_to IS NULL`) successful QM job for the
 * given cache key. Returns `null` if no live row exists or the live row
 * is in a non-terminal status — callers should treat that as a cache miss
 * and dispatch a fresh MCP call.
 */
export async function lookupQmCache(
  pool: Pool,
  cacheKey: Buffer,
): Promise<QmJobRow | null> {
  return withSystemContext(pool, async (client) => {
    const res = await client.query<{
      id: string;
      status: string;
      method: string;
      task: string;
      smiles_canonical: string | null;
      energy_hartree: number | null;
      converged: boolean | null;
      summary_md: string | null;
      recorded_at: string;
    }>(
      `SELECT j.id::text AS id,
              j.status,
              j.method,
              j.task,
              j.smiles_canonical,
              r.energy_hartree,
              r.converged,
              r.summary_md,
              j.recorded_at
         FROM qm_jobs j
         LEFT JOIN qm_results r ON r.job_id = j.id
        WHERE j.cache_key = $1
          AND j.valid_to IS NULL
          AND j.status = 'succeeded'
        LIMIT 1`,
      [cacheKey],
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0]!;
    log.debug(
      { event: "qm_cache_hit", job_id: row.id, method: row.method, task: row.task },
      "qm cache hit",
    );
    return {
      id: row.id,
      status: row.status,
      method: row.method,
      task: row.task,
      smilesCanonical: row.smiles_canonical,
      energyHartree: row.energy_hartree,
      converged: row.converged,
      summaryMd: row.summary_md,
      recordedAt: row.recorded_at,
    };
  });
}

/**
 * Force-invalidate every live cached job whose cache key matches.
 * Returns the count of rows newly closed.
 *
 * NOTE: not a hard delete — sets `valid_to = NOW()` so the bi-temporal
 * audit trail is preserved. A fresh job inserted with the same cache_key
 * will become the new live row.
 */
export async function invalidateQmCache(
  pool: Pool,
  cacheKey: Buffer,
): Promise<number> {
  return withSystemContext(pool, async (client) => {
    const res = await client.query(
      `UPDATE qm_jobs
          SET valid_to = NOW()
        WHERE cache_key = $1
          AND valid_to IS NULL`,
      [cacheKey],
    );
    if (res.rowCount && res.rowCount > 0) {
      log.info(
        { event: "qm_cache_invalidated", rows: res.rowCount },
        "qm cache rows invalidated",
      );
    }
    return res.rowCount ?? 0;
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  // Same shape as Python's json.dumps(..., sort_keys=True, separators=(",", ":")).
  // For top-level objects we sort keys recursively; arrays preserve order.
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}
