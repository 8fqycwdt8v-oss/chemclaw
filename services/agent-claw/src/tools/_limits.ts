// Shared length / count bounds for chemistry payloads.
//
// Mirror of `services/mcp_tools/common/limits.py`. Keep both files in sync
// by hand — there are five constants and the cost of one drift PR is much
// smaller than the cost of running a codegen pipeline for five lines.
//
// Why these exist: prior to cycle 2 of the MCP review, the TypeScript
// builtins did not enforce a per-element max on list inputs, so a
// [101 × 21_000-char SMILES] payload passed Zod, hit the wire, and 422'd
// server-side after burning the outbound 60 s timeout.

/** A single SMILES string. */
export const MAX_SMILES_LEN = 10_000;

/** A single reaction SMILES string (reagents>>products, optionally with
 *  reagents>catalysts>products three-segment form). */
export const MAX_RXN_SMILES_LEN = 20_000;

/** Maximum number of SMILES per list-shaped endpoint. */
export const MAX_BATCH_SMILES = 100;

/** Maximum number of reaction SMILES per list-shaped endpoint. */
export const MAX_BATCH_RXN_SMILES = 1_000;

/** InChIKey upper bound (the spec is 27 chars; we allow whitespace slop). */
export const MAX_INCHIKEY_LEN = 32;
