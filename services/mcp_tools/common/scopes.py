"""Single source of truth for per-service MCP scopes (ADR 006 Layer 2).

Each MCP service has one coarse scope. The agent mints tokens carrying that
scope when calling the service; the service's middleware enforces it via
``create_app(required_scope=...)``. Tokens minted for one service must NOT
be accepted by another, even if both run behind the same signing key —
the ``aud`` claim (added in cycle 3) closes the per-service replay.

The TypeScript mirror lives at
``services/agent-claw/src/security/mcp-token-cache.ts`` (``SERVICE_SCOPES``).
A pact test in ``tests/integration/test_scope_pact.py`` asserts equality
across the language boundary so a typo on either side fails CI before it
ships a silent 403 in production (which dev mode would hide).

Service names match the docker-compose / Helm container names exactly.
"""

from __future__ import annotations

SERVICE_SCOPES: dict[str, str] = {
    "mcp-rdkit": "mcp_rdkit:invoke",
    "mcp-drfp": "mcp_drfp:invoke",
    "mcp-kg": "mcp_kg:rw",
    "mcp-embedder": "mcp_embedder:invoke",
    "mcp-tabicl": "mcp_tabicl:invoke",
    "mcp-doc-fetcher": "mcp_doc_fetcher:fetch",
    "mcp-askcos": "mcp_askcos:invoke",
    "mcp-aizynth": "mcp_aizynth:invoke",
    "mcp-chemprop": "mcp_chemprop:invoke",
    "mcp-yield-baseline": "mcp_yield_baseline:invoke",
    "mcp-reaction-optimizer": "mcp_reaction_optimizer:invoke",
    "mcp-plate-designer": "mcp_plate_designer:invoke",
    "mcp-ord-io": "mcp_ord_io:invoke",
    "mcp-xtb": "mcp_xtb:invoke",
    "mcp-crest": "mcp_crest:invoke",
    "mcp-genchem": "mcp_genchem:invoke",
    "mcp-sirius": "mcp_sirius:invoke",
    "mcp-eln-local": "mcp_eln:read",
    "mcp-logs-sciy": "mcp_instrument:read",
    "mcp-synthegy-mech": "mcp_synthegy_mech:invoke",
}
