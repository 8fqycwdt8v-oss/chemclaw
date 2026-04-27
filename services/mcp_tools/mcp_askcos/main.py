"""mcp-askcos — ASKCOS v2 retrosynthesis as a tool service (port 8007).

Tools:
- POST /retrosynthesis    — multi-step retrosynthesis route proposal
- POST /forward_prediction — forward reaction product prediction

ASKCOS is a heavy ML service with pretrained model checkpoints.
The client is dependency-injected and mocked in tests.
/readyz returns 503 when the model checkpoint directory is missing.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Annotated

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

def _get_askcos_client():
    """Return an ASKCOS v2 client.  Raises ImportError if not installed."""
    try:
        from askcos2 import AskCOSClient  # type: ignore[import]  # noqa: PLC0415
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_askcos.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
