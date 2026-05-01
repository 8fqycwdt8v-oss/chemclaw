"""mcp-synthegy-mech — LLM-guided mechanism elucidation (port 8011).

Implements Bran et al., *Matter* 2026, DOI 10.1016/j.matt.2026.102812 — an
A* search over arrow-pushing primitives (ionization + attack moves), where
the LLM scores candidate next-states 0..10 at each search step.

Tools:
- POST /elucidate_mechanism  — returns a sequence of intermediate SMILES
  from reactants to products with per-step LLM scores.

Architecture notes:
- The search loop is in `mechanism_search.py` (adapted from STEER's astar.py).
- The deterministic move enumerator is vendored in `vendored/molecule_set.py`.
- The LLM scoring policy in `llm_policy.py` calls ChemClaw's central LiteLLM
  proxy via `litellm.acompletion(api_base=$LITELLM_BASE_URL)` so every prompt
  traverses the redactor callback (`services/litellm_redactor/callback.py`).
- xTB-based energy validation is live via `XtbValidator` → `mcp-xtb`.
  Populates `energy_delta_hartree` per move when `validate_energies=True`.
  Failures surface as `warnings` entries; the mechanism itself still
  returns successfully.
- A server-side wall-clock timeout (270 s) caps runaway LLM spending if
  the upstream is slow; cancellation propagates cleanly through both the
  scoring policy and the xtb validator.

Limitations (from the paper):
- Ionic chemistry only — radicals and pericyclic mechanisms are upstream
  future work. The MCP surfaces a `warnings` entry when input SMILES
  contain a radical-like pattern.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Annotated, Literal

from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings
from services.mcp_tools.mcp_synthegy_mech.llm_policy import LiteLLMScoringPolicy
from services.mcp_tools.mcp_synthegy_mech.mechanism_search import MechanismSearch
from services.mcp_tools.mcp_synthegy_mech.move_diff import derive_move
from services.mcp_tools.mcp_synthegy_mech.vendored import prompt_canonical
from services.mcp_tools.mcp_synthegy_mech.xtb_validator import (
    XtbValidator,
    compute_energy_deltas,
)

# mcp-xtb URL for Phase 3 energy validation. Reads from env at module import
# so tests can monkey-patch it via os.environ before TestClient construction.
_DEFAULT_MCP_XTB_URL = os.environ.get("MCP_XTB_BASE_URL", "http://mcp-xtb:8010")

# Cycle-3 cost cap. The agent-side timeout is 300 s
# (TIMEOUT_SYNTHEGY_MECH_MS in elucidate_mechanism.ts). Without a matching
# server-side wall-clock cap, a slow LiteLLM upstream lets the search loop
# keep issuing LLM calls — and accumulating cost — long after the agent
# gave up. We cap server-side at 270 s (30 s under the client) so the
# search is cancelled cleanly before the client disconnects, freeing
# LiteLLM resources and stopping the spending.
_SERVER_SEARCH_TIMEOUT_S = 270.0

log = logging.getLogger("mcp-synthegy-mech")
settings = ToolSettings()


def _ready_check() -> bool:
    """Ready when RDKit imports cleanly and we can build a stub policy.

    We deliberately do NOT verify LiteLLM connectivity at boot — the proxy
    can be temporarily down without the service needing to fail-closed at
    `/readyz`. Per-request 5xx-from-upstream is the right failure mode.
    """
    try:
        from rdkit import Chem  # noqa: F401, PLC0415
    except ImportError:
        return False
    return True


app = create_app(
    name="mcp-synthegy-mech",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_ready_check,
    required_scope="mcp_synthegy_mech:invoke",
)


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

# The paper's strongest single model is gemini-2.5-pro; the strongest model in
# ChemClaw's default LiteLLM config is the Sonnet 4.7 alias. Default to the
# latter so the service works out of the box; allow opt-in for the others.
ALLOWED_MODELS = Literal[
    "executor",          # Sonnet 4.7 alias from services/litellm/config.yaml
    "planner",           # Opus 4.7 alias
    "compactor",         # Haiku 4.5 alias — for cheap-but-noisy benchmarks
    "claude-sonnet-4-7",
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-haiku-4-5",
    "gemini-2.5-pro",    # paper-best, requires GOOGLE_API_KEY in litellm config
    "gpt-4o",
    "deepseek-r1",
]


class ElucidateMechanismIn(BaseModel):
    reactants_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    products_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    max_nodes: int = Field(
        default=200,
        ge=1,
        le=400,
        description=(
            "Upper bound on A* nodes explored. The paper's demos hit ~200 "
            "LLM calls per mechanism; cap at 400 to bound cost."
        ),
    )
    conditions: str | None = Field(default=None, max_length=500)
    guidance_prompt: str | None = Field(
        default=None,
        max_length=4_000,
        description=(
            "Optional natural-language hint about the expected mechanism. "
            "Materially improves scoring quality (paper Figure 4E)."
        ),
    )
    validate_energies: bool = Field(
        default=False,
        description=(
            "Validate intermediates via mcp-xtb GFN2-xTB single-point energy. "
            "Populates `energy_delta_hartree` per move. Adds ~10-30 s per "
            "unique intermediate; off by default for speed."
        ),
    )
    model: ALLOWED_MODELS = "executor"


class Move(BaseModel):
    from_smiles: str                     # state before this move (authoritative).
    to_smiles: str                       # state after this move (authoritative).
    score: float = Field(ge=0.0, le=10.0)
    derived_kind: Literal["i", "a"] | None = None
    derived_atom_x: int | None = None
    derived_atom_y: int | None = None
    energy_delta_hartree: float | None = None  # populated only if validate_energies.


class ElucidateMechanismOut(BaseModel):
    moves: list[Move]
    reactants_smiles: str                # canonicalized echo
    products_smiles: str                 # canonicalized echo
    total_llm_calls: int
    total_nodes_explored: int
    prompt_tokens: int
    completion_tokens: int
    parse_failures: int
    upstream_errors: int
    warnings: list[str]
    truncated: bool                      # True if max_nodes hit before reaching products.


# ---------------------------------------------------------------------------
# Heuristics for input warnings
# ---------------------------------------------------------------------------

# Crude but consistent with the paper's documented limitation: ionic chemistry
# only. We surface a warning when the input looks radical-y or pericyclic.
# Quantifiers are bounded per CLAUDE.md's "bound every quantifier" rule.
# Element symbols are 1-3 chars (Uup, Uuh exist); explicit-charge tail is at
# most 4 digits (no real molecule has more than that). 8 + tail keeps this
# linear-time even on a 10 000-char input.
_RADICAL_HINT = re.compile(r"\[[A-Za-z]{1,3}\.[+-]?\d{0,4}\]")  # e.g. [O.] or [C.+]

# Synthegy's canonical prompt template uses these XML tags as structural
# delimiters. Any user-supplied free-text field is concatenated *into* that
# template — if a malicious caller types a closing tag mid-string, the LLM
# can be tricked into reading subsequent text as instructions outside the
# query block. Strip these tokens (case-insensitive) before concatenation.
# Worst-case sans this stripper is biased scoring, not RCE (temperature=0.1,
# no tool-calling on the scored prompt) — but biased scoring on a system
# meant to act autonomously on pharma-data is its own integrity issue.
_PROMPT_STRUCTURAL_TAGS = re.compile(
    r"</?\s*(target_reaction|proposed_mechanism|potential_next_step|"
    r"mechanism_evaluation|score_justification|score|query|analysis)\s*>",
    re.IGNORECASE,
)


def _strip_prompt_tags(text: str) -> str:
    """Remove Synthegy's structural XML tags from user-supplied free text.

    Keeps the rest of the text intact; just neutralizes the delimiters that
    would otherwise let a caller escape into instruction position. Idempotent.
    """
    return _PROMPT_STRUCTURAL_TAGS.sub("", text)


def _diagnose_warnings(reactants: str, products: str) -> list[str]:
    warnings: list[str] = []
    if _RADICAL_HINT.search(reactants) or _RADICAL_HINT.search(products):
        warnings.append(
            "Input appears to contain a radical species ([X.] notation). "
            "Synthegy's mechanism game is ionic only; results may be unreliable. "
            "Paper documents radicals/pericyclics as future work."
        )
    return warnings


def _canonical_smiles(smiles: str) -> str:
    from rdkit import Chem  # noqa: PLC0415
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        # Don't echo the input value into the error — proprietary SMILES
        # would round-trip through the response body. The request_id in the
        # server log correlates to the rejected payload for debugging.
        raise ValueError("invalid SMILES (RDKit parse failed)")
    return Chem.MolToSmiles(mol)


# ---------------------------------------------------------------------------
# /elucidate_mechanism
# ---------------------------------------------------------------------------


@app.post(
    "/elucidate_mechanism",
    response_model=ElucidateMechanismOut,
    tags=["synthegy"],
)
async def elucidate_mechanism(
    req: Annotated[ElucidateMechanismIn, Body(...)],
) -> ElucidateMechanismOut:
    # Validate inputs via RDKit canonicalization. Raises ValueError → 400.
    # Off-thread because RDKit MolFromSmiles/MolToSmiles are synchronous
    # C-extension calls (~0.5-2 ms each on normal-size molecules) and we
    # don't want them stalling the event loop.
    reactants_canonical = await asyncio.to_thread(_canonical_smiles, req.reactants_smiles)
    products_canonical = await asyncio.to_thread(_canonical_smiles, req.products_smiles)

    warnings = _diagnose_warnings(req.reactants_smiles, req.products_smiles)

    # Build the prompt for the LLM policy. If the user supplied a guidance
    # prompt, prepend it as a "## Guidance" block before the canonical prompt
    # — the paper documents this materially boosts scoring (Figure 4E).
    # User-supplied free text is run through `_strip_prompt_tags` first so
    # that a closing-tag injection can't escape the canonical template's
    # query/proposed_mechanism/score delimiters.
    prefix = prompt_canonical.prefix
    if req.guidance_prompt:
        prefix = (
            "## Guidance from caller\n\n"
            + _strip_prompt_tags(req.guidance_prompt.strip())
            + "\n\n"
            + prefix
        )
    if req.conditions:
        prefix = (
            "## Reaction conditions\n\n"
            + _strip_prompt_tags(req.conditions.strip())
            + "\n\n"
            + prefix
        )

    policy = LiteLLMScoringPolicy(
        model=req.model,
        prompt_prefix=prefix,
        prompt_intermed=prompt_canonical.intermed,
        prompt_suffix=prompt_canonical.suffix,
    )

    search = MechanismSearch(policy=policy, max_nodes=req.max_nodes)
    try:
        result = await asyncio.wait_for(
            search.search(reactants_canonical, products_canonical),
            timeout=_SERVER_SEARCH_TIMEOUT_S,
        )
    except asyncio.TimeoutError:
        # Server wall-clock cap fired. The asyncio cancellation we triggered
        # propagates through llm_policy and xtb_validator (both re-raise
        # CancelledError) so outstanding LLM calls and httpx tasks are
        # cancelled, freeing upstream resources. Return a graceful
        # truncated response — the agent's TIMEOUT_SYNTHEGY_MECH_MS
        # would otherwise abort the connection in 30 s anyway.
        log.warning(
            "Server-side search timeout fired after %.0fs (max_nodes=%d, model=%s)",
            _SERVER_SEARCH_TIMEOUT_S,
            req.max_nodes,
            req.model,
        )
        warnings.append(
            f"Server-side search timeout ({_SERVER_SEARCH_TIMEOUT_S:.0f}s) "
            f"fired before completion. LLM cost is bounded; the moves list "
            f"is empty. Reduce max_nodes or refine the guidance_prompt."
        )
        return ElucidateMechanismOut(
            moves=[],
            reactants_smiles=reactants_canonical,
            products_smiles=products_canonical,
            total_llm_calls=policy.stats.total_calls,
            total_nodes_explored=0,
            prompt_tokens=policy.stats.prompt_tokens,
            completion_tokens=policy.stats.completion_tokens,
            parse_failures=policy.stats.parse_failures,
            upstream_errors=policy.stats.upstream_errors,
            warnings=warnings,
            truncated=True,
        )

    # The path is [src, intermediate1, intermediate2, ..., dest]. Convert to
    # consecutive (from, to) moves with their scores.
    # Cycle-2 fix M-3: pin the invariant that scores and path align.
    # Otherwise zip(...) silently truncates if a future refactor diverges
    # the two lengths, dropping moves from the response with no error.
    if len(result.scores) != len(result.path):
        raise RuntimeError(
            f"Internal: search returned scores/path length mismatch "
            f"({len(result.scores)} vs {len(result.path)})"
        )
    move_endpoints: list[tuple[str, str]] = []
    for i in range(1, len(result.path)):
        move_endpoints.append((result.path[i - 1], result.path[i]))

    # Optional Phase 3 energy validation via mcp-xtb. Run *after* the search
    # so a misconfigured xtb URL never aborts a successful mechanism return.
    energy_deltas: list[float | None] = [None] * len(move_endpoints)
    if req.validate_energies and move_endpoints:
        validator = XtbValidator(xtb_base_url=_DEFAULT_MCP_XTB_URL)
        # Validate every unique state along the path (both endpoints).
        unique_states = list({s for endpoints in move_endpoints for s in endpoints})
        v_result = await validator.validate(unique_states)
        warnings.extend(v_result.warnings)
        energy_deltas = compute_energy_deltas(move_endpoints, v_result.energy_per_smiles)

    moves: list[Move] = []
    for (from_smi, to_smi), delta, score in zip(
        move_endpoints, energy_deltas, result.scores[1:]
    ):
        derived = derive_move(from_smi, to_smi)
        moves.append(
            Move(
                from_smiles=from_smi,
                to_smiles=to_smi,
                score=float(score),
                derived_kind=derived.kind if derived else None,
                derived_atom_x=derived.atom_x if derived else None,
                derived_atom_y=derived.atom_y if derived else None,
                energy_delta_hartree=delta,
            )
        )

    if result.truncated:
        warnings.append(
            f"Search budget exhausted after {result.nodes_explored} nodes "
            f"without reaching the product. The moves list is empty — "
            f"the response carries no mechanism. "
            f"Increase max_nodes (currently {req.max_nodes}, max 400) or "
            f"refine the guidance_prompt."
        )

    return ElucidateMechanismOut(
        moves=moves,
        reactants_smiles=reactants_canonical,
        products_smiles=products_canonical,
        total_llm_calls=policy.stats.total_calls,
        total_nodes_explored=result.nodes_explored,
        prompt_tokens=policy.stats.prompt_tokens,
        completion_tokens=policy.stats.completion_tokens,
        parse_failures=policy.stats.parse_failures,
        upstream_errors=policy.stats.upstream_errors,
        warnings=warnings,
        truncated=result.truncated,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_synthegy_mech.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
