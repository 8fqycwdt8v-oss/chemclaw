// Cross-language pact: TS computeQmCacheKey must match Python qm_cache_key.
//
// The Python pytest writes tests/fixtures/qm_hash_parity_vectors.tsv with
// one row per <hex>\t<JSON-input> entry. We consume the TSV and assert
// that computeQmCacheKey produces the exact same hex digest. If the
// fixture is missing (Python tests haven't run in this build), we skip.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { computeQmCacheKey } from "../../src/db/qm-cache.js";

const FIXTURE = join(
  __dirname,
  "..",
  "fixtures",
  "qm_hash_parity_vectors.tsv",
);

interface PyVector {
  method: string;
  task: string;
  smiles_canonical: string;
  charge?: number;
  multiplicity?: number;
  solvent_model?: string;
  solvent_name?: string;
  params?: Record<string, unknown>;
}

describe("qm_hash cross-language pact", () => {
  it("TS digests match the Python-side fixture", () => {
    if (!existsSync(FIXTURE)) {
      console.warn(
        "qm-cache-pact: fixture missing; run pytest services/projectors/qm_kg/tests/test_qm_hash_pact.py first",
      );
      return;
    }
    const lines = readFileSync(FIXTURE, "utf-8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const [pyHex, jsonRaw] = line.split("\t");
      expect(pyHex).toMatch(/^[0-9a-f]{64}$/);
      const v: PyVector = JSON.parse(jsonRaw!);
      const tsHex = computeQmCacheKey({
        method: v.method as "GFN2",
        task: v.task as "opt",
        smilesCanonical: v.smiles_canonical,
        charge: v.charge,
        multiplicity: v.multiplicity,
        solventModel: v.solvent_model as "alpb" | "gbsa" | "cpcmx" | "none" | undefined,
        solventName: v.solvent_name,
        params: v.params,
      }).toString("hex");
      expect(tsHex).toBe(pyHex);
    }
  });
});
