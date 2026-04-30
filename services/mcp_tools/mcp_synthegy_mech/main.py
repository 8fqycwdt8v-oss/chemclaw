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
- xTB-based energy validation is wired in for Phase 3 but is a stub here:
  when `validate_energies=True`, the response surfaces a warning and leaves
  `energy_delta_hartree=None` per move. Phase 3 will implement the call to
  mcp-xtb.

Limitations (from the paper):
- Ionic chemistry only — radicals and pericyclic mechanisms are upstream
  future work. The MCP surfaces a `warnings` entry when input SMILES
  contain a radical-like pattern.
"""
from __future__ import annotations

import logging
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
            "Phase 3: validate intermediates via mcp-xtb single-point energy. "
            "Currently a stub — emits a warning and leaves "
            "`energy_delta_hartree=None` per move."
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
_RADICAL_HINT = re.compile(r"\[[A-Za-z]+\.[+-]?\d*\]")  # e.g. [O.] or [C.+]


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
        raise ValueError(f"invalid SMILES: {smiles!r}")
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
    reactants_canonical = _canonical_smiles(req.reactants_smiles)
    products_canonical = _canonical_smiles(req.products_smiles)

    warnings = _diagnose_warnings(req.reactants_smiles, req.products_smiles)

    # Build the prompt for the LLM policy. If the user supplied a guidance
    # prompt, prepend it as a "## Guidance" block before the canonical prompt
    # — the paper documents this materially boosts scoring (Figure 4E).
    prefix = prompt_canonical.prefix
    if req.guidance_prompt:
        prefix = (
            "## Guidance from caller\n\n"
            + req.guidance_prompt.strip()
            + "\n\n"
            + prefix
        )
    if req.conditions:
        prefix = (
            "## Reaction conditions\n\n"
            + req.conditions.strip()
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
    result = await search.search(reactants_canonical, products_canonical)

    # The path is [src, intermediate1, intermediate2, ..., dest]. Convert to
    # consecutive (from, to) moves with their scores.
    moves: list[Move] = []
    for i in range(1, len(result.path)):
        from_smi = result.path[i - 1]
        to_smi = result.path[i]
        derived = derive_move(from_smi, to_smi)
        moves.append(
            Move(
                from_smiles=from_smi,
                to_smiles=to_smi,
                score=float(result.scores[i]),
                derived_kind=derived.kind if derived else None,
                derived_atom_x=derived.atom_x if derived else None,
                derived_atom_y=derived.atom_y if derived else None,
                energy_delta_hartree=None,  # Phase 3 stub.
            )
        )

    if req.validate_energies:
        warnings.append(
            "validate_energies=True received but xTB validation is a Phase 3 "
            "stub — energy_delta_hartree fields are None."
        )

    if result.truncated:
        warnings.append(
            f"Search budget exhausted after {result.nodes_explored} nodes "
            f"without reaching the product. Returned the search root only; "
            f"increase max_nodes (currently {req.max_nodes}, max 400) or "
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
