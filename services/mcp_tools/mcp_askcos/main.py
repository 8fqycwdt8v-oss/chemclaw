"""mcp-askcos — ASKCOS v2 retrosynthesis as a tool service (port 8007).

Tools:
- POST /retrosynthesis        — multi-step retrosynthesis route proposal
- POST /forward_prediction    — forward reaction product prediction
- POST /recommend_conditions  — top-k condition sets for a target reaction
                                (catalyst/reagent/solvent/temperature)

ASKCOS is a heavy ML service with pretrained model checkpoints.
The client is dependency-injected and mocked in tests.
/readyz returns 503 when the model checkpoint directory is missing.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Annotated, Any

from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-askcos")
settings = ToolSettings()

# Model checkpoint directory — must exist for the service to be ready.
_MODEL_DIR = Path(os.environ.get("ASKCOS_MODEL_DIR", "/var/lib/mcp-askcos/models"))


def _is_ready() -> bool:
    return _MODEL_DIR.exists() and _MODEL_DIR.is_dir()


app = create_app(
    name="mcp-askcos",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_askcos:invoke",
)


# ---------------------------------------------------------------------------
# Lazy ASKCOS client (avoids import-time crash when askcos is not installed)
# ---------------------------------------------------------------------------

def _get_askcos_client() -> Any:
    """Return an ASKCOS v2 client.  Raises ImportError if not installed.

    Returns Any because askcos2 ships no stubs; callers treat the client
    as a duck-typed object (see retrosynthesis() / forward_prediction()).
    """
    try:
        from askcos2 import AskCOSClient  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError(
            "askcos2 package not installed; install it inside the Docker image"
        ) from exc
    return AskCOSClient()


# ---------------------------------------------------------------------------
# /retrosynthesis
# ---------------------------------------------------------------------------

class RetroStep(BaseModel):
    reaction_smiles: str
    score: float = Field(ge=0.0, le=1.0)
    sources_count: int = Field(ge=0)


class RetroRoute(BaseModel):
    steps: list[RetroStep]
    total_score: float = Field(ge=0.0)
    depth: int = Field(ge=1)


class RetrosynthesisIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    max_depth: int = Field(default=3, ge=1, le=6)
    max_branches: int = Field(default=4, ge=1, le=10)


class RetrosynthesisOut(BaseModel):
    routes: list[RetroRoute]


@app.post("/retrosynthesis", response_model=RetrosynthesisOut, tags=["askcos"])
async def retrosynthesis(
    req: Annotated[RetrosynthesisIn, Body(...)],
) -> RetrosynthesisOut:
    if not req.smiles.strip():
        raise ValueError("smiles must be a non-empty string")

    client = _get_askcos_client()
    raw_routes = client.retrosynthesis(
        target=req.smiles,
        max_depth=req.max_depth,
        max_branches=req.max_branches,
    )

    routes: list[RetroRoute] = []
    for route in raw_routes:
        steps = [
            RetroStep(
                reaction_smiles=s["reaction_smiles"],
                score=float(s["score"]),
                sources_count=int(s.get("sources_count", 0)),
            )
            for s in route["steps"]
        ]
        routes.append(
            RetroRoute(
                steps=steps,
                total_score=float(route["total_score"]),
                depth=len(steps),
            )
        )

    return RetrosynthesisOut(routes=routes)


# ---------------------------------------------------------------------------
# /forward_prediction
# ---------------------------------------------------------------------------

class ForwardProduct(BaseModel):
    smiles: str
    score: float = Field(ge=0.0, le=1.0)


class ForwardPredictionIn(BaseModel):
    reactants_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    conditions: str | None = Field(default=None, max_length=1_000)


class ForwardPredictionOut(BaseModel):
    products: list[ForwardProduct]


@app.post("/forward_prediction", response_model=ForwardPredictionOut, tags=["askcos"])
async def forward_prediction(
    req: Annotated[ForwardPredictionIn, Body(...)],
) -> ForwardPredictionOut:
    if not req.reactants_smiles.strip():
        raise ValueError("reactants_smiles must be a non-empty string")

    client = _get_askcos_client()
    raw_products = client.forward_prediction(
        reactants=req.reactants_smiles,
        conditions=req.conditions,
    )

    products = [
        ForwardProduct(smiles=p["smiles"], score=float(p["score"]))
        for p in raw_products
    ]
    return ForwardPredictionOut(products=products)


# ---------------------------------------------------------------------------
# /recommend_conditions
#
# Wraps ASKCOS's condition recommender (Coley/Gao 2018 + 2024 refresh):
# given a target reaction (reactants + product), return top-k condition sets
# {catalysts, reagents, solvents, temperature_c, score}. Each list-typed field
# is normalized to [{smiles, name}] entries; empty lists are valid.
#
# The client is duck-typed; tests mock recommend_conditions(...).
# ---------------------------------------------------------------------------

class CompoundRef(BaseModel):
    """A single chemical reference inside a condition slot.

    `smiles` may be empty when ASKCOS returns a name-only entry; both must be
    valid strings even if one is empty.
    """

    smiles: str = Field(default="", max_length=MAX_SMILES_LEN)
    name: str = Field(default="", max_length=200)


class ConditionSet(BaseModel):
    catalysts: list[CompoundRef] = Field(default_factory=list)
    reagents: list[CompoundRef] = Field(default_factory=list)
    solvents: list[CompoundRef] = Field(default_factory=list)
    temperature_c: float | None = Field(default=None, ge=-100.0, le=500.0)
    score: float = Field(ge=0.0, le=1.0)


class RecommendConditionsIn(BaseModel):
    reactants_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    product_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    top_k: int = Field(default=5, ge=1, le=20)


class RecommendConditionsOut(BaseModel):
    recommendations: list[ConditionSet]
    model_id: str = Field(default="askcos_condition_recommender@v2")


def _normalize_compound_list(raw: Any) -> list[CompoundRef]:
    """Coerce ASKCOS condition-slot output to a CompoundRef list.

    The upstream client returns either:
      - list[str]          — bare SMILES
      - list[dict]         — {"smiles": "...", "name": "..."} entries
      - None / missing     — empty
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError(f"expected list for condition slot, got {type(raw).__name__}")
    out: list[CompoundRef] = []
    for item in raw:
        if isinstance(item, str):
            out.append(CompoundRef(smiles=item, name=""))
        elif isinstance(item, dict):
            out.append(
                CompoundRef(
                    smiles=str(item.get("smiles", "")),
                    name=str(item.get("name", "")),
                )
            )
        else:
            raise ValueError(
                f"expected str or dict in condition slot, got {type(item).__name__}"
            )
    return out


@app.post(
    "/recommend_conditions",
    response_model=RecommendConditionsOut,
    tags=["askcos"],
)
async def recommend_conditions(
    req: Annotated[RecommendConditionsIn, Body(...)],
) -> RecommendConditionsOut:
    if not req.reactants_smiles.strip():
        raise ValueError("reactants_smiles must be a non-empty string")
    if not req.product_smiles.strip():
        raise ValueError("product_smiles must be a non-empty string")

    client = _get_askcos_client()
    raw = client.recommend_conditions(
        reactants=req.reactants_smiles,
        product=req.product_smiles,
        n=req.top_k,
    )

    if not isinstance(raw, list):
        raise ValueError(
            f"askcos client returned non-list ({type(raw).__name__}); expected list"
        )

    recommendations: list[ConditionSet] = []
    for entry in raw:
        if not isinstance(entry, dict):
            raise ValueError(
                f"expected dict per recommendation, got {type(entry).__name__}"
            )
        temp = entry.get("temperature")
        recommendations.append(
            ConditionSet(
                catalysts=_normalize_compound_list(entry.get("catalyst")),
                reagents=_normalize_compound_list(entry.get("reagent")),
                solvents=_normalize_compound_list(entry.get("solvent")),
                temperature_c=float(temp) if temp is not None else None,
                score=float(entry.get("score", 0.0)),
            )
        )

    return RecommendConditionsOut(recommendations=recommendations)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_askcos.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
