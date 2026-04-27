"""Shared length / count bounds used by the MCP tool services.

These constants are the single source of truth for "how long a SMILES is
allowed to be" and "how many of them per request." Each MCP service used to
hard-code its own limits, which led to two drift bugs the audit caught:

  - mcp_drfp / mcp_tabicl accepted rxn_smiles up to 20 000 chars while
    mcp_chemprop / mcp_askcos / mcp_aizynth capped at 10 000. A request the
    DRFP vectoriser accepted would 422 at the TabPFN-feeding step.
  - The TypeScript builtins did not enforce a per-element max at all on
    list inputs, so a [101 × 21_000-char SMILES] payload passed Zod, hit
    the wire, and 422'd server-side after burning the agent's outbound
    timeout budget.

The mirror file `services/agent-claw/src/tools/_limits.ts` carries the same
constants for the TypeScript side. Keep them in sync by hand — there are
five constants and the cost of one drift PR is much smaller than the cost
of running a codegen pipeline for five lines.
"""

from __future__ import annotations

# A single SMILES string. RDKit / Chemprop accept arbitrary-length strings,
# but realistic molecules fit easily; this is a DoS guard, not a chemistry
# correctness guard.
MAX_SMILES_LEN = 10_000

# Reaction SMILES carry reagents on both sides plus optional catalysts and
# solvents, so they're allowed to be much longer. DRFP and the reaction
# vectoriser both currently accept 20 000.
MAX_RXN_SMILES_LEN = 20_000

# Batch sizes for list-shaped endpoints. Calibrated to match the highest
# value any MCP currently uses; lifting these requires touching
# featurize/predict pipelines, so they are intentionally conservative.
MAX_BATCH_SMILES = 100
MAX_BATCH_RXN_SMILES = 1_000

# InChIKey is fixed-length (27 chars including dashes) but inputs may carry
# extra whitespace; this cap prevents pathological payloads.
MAX_INCHIKEY_LEN = 32
