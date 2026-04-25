"""mcp-admetlab — ADMETlab 3.0 ADMET 119-endpoint screen (port 8011).

Tools:
- POST /screen — batch ADMET screen for a list of SMILES

Mode selection (checked at startup):
  1. ADMETLAB_API_KEY env → calls the hosted ADMETlab 3.0 API.
  2. ADMETLAB_MODEL_DIR env points to a local model directory → runs locally.
  3. Neither → /readyz returns 503.

/screen input is capped at 50 SMILES per request.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Annotated, Any

import httpx
from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-admetlab")
settings = ToolSettings()

_API_KEY = os.environ.get("ADMETLAB_API_KEY", "")
_MODEL_DIR = Path(os.environ.get("ADMETLAB_MODEL_DIR", "/var/lib/mcp-admetlab/models"))
_ADMETLAB_API_URL = os.environ.get("ADMETLAB_API_URL", "https://admetlab3.scbdd.com/api")

_MAX_SMILES = 50


def _is_ready() -> bool:
    return bool(_API_KEY) or (_MODEL_DIR.exists() and _MODEL_DIR.is_dir())


app = create_app(
    name="mcp-admetlab",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
)


# ---------------------------------------------------------------------------
# ADMETlab result models
# ---------------------------------------------------------------------------

class AdmetEndpoints(BaseModel):
    absorption: dict[str, Any] = Field(default_factory=dict)
    distribution: dict[str, Any] = Field(default_factory=dict)
    metabolism: dict[str, Any] = Field(default_factory=dict)
    excretion: dict[str, Any] = Field(default_factory=dict)
    toxicity: dict[str, Any] = Field(default_factory=dict)


class AdmetPrediction(BaseModel):
    smiles: str
    endpoints: AdmetEndpoints
    alerts: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Backend: hosted API
# ---------------------------------------------------------------------------

async def _screen_via_api(smiles_list: list[str]) -> list[AdmetPrediction]:
    """Call the ADMETlab 3.0 hosted REST API."""
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            f"{_ADMETLAB_API_URL}/predict",
            json={"smiles": smiles_list},
            headers={"X-API-Key": _API_KEY},
        )
        resp.raise_for_status()
        data = resp.json()

    results: list[AdmetPrediction] = []
    for item in data.get("results", []):
        pred = AdmetPrediction(
            smiles=item["smiles"],
            endpoints=AdmetEndpoints(
                absorption=item.get("absorption", {}),
                distribution=item.get("distribution", {}),
                metabolism=item.get("metabolism", {}),
                excretion=item.get("excretion", {}),
                toxicity=item.get("toxicity", {}),
            ),
            alerts=item.get("alerts", []),
        )
        results.append(pred)
    return results


# ---------------------------------------------------------------------------
# Backend: local model
# ---------------------------------------------------------------------------

async def _screen_via_local(smiles_list: list[str]) -> list[AdmetPrediction]:
    """Run ADMETlab predictions locally using the downloaded model checkpoint."""
    try:
        from admetlab3 import LocalPredictor  # type: ignore[import]  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError(
            "admetlab3 local package not installed; set ADMETLAB_API_KEY to use the hosted API"
        ) from exc

    predictor = LocalPredictor(model_dir=str(_MODEL_DIR))
    raw = predictor.predict(smiles_list)

    results: list[AdmetPrediction] = []
    for item in raw:
        results.append(
            AdmetPrediction(
                smiles=item["smiles"],
                endpoints=AdmetEndpoints(
                    absorption=item.get("absorption", {}),
                    distribution=item.get("distribution", {}),
                    metabolism=item.get("metabolism", {}),
                    excretion=item.get("excretion", {}),
                    toxicity=item.get("toxicity", {}),
                ),
                alerts=item.get("alerts", []),
            )
        )
    return results


# ---------------------------------------------------------------------------
# /screen
# ---------------------------------------------------------------------------

class ScreenIn(BaseModel):
    smiles_list: list[str] = Field(min_length=1, max_length=_MAX_SMILES)


class ScreenOut(BaseModel):
    predictions: list[AdmetPrediction]


@app.post("/screen", response_model=ScreenOut, tags=["admetlab"])
async def screen(
    req: Annotated[ScreenIn, Body(...)],
) -> ScreenOut:
    if not req.smiles_list:
        raise ValueError("smiles_list must not be empty")
    if len(req.smiles_list) > _MAX_SMILES:
        raise ValueError(f"smiles_list length exceeds max {_MAX_SMILES}")

    # Validate SMILES before calling the backend.
    for smi in req.smiles_list:
        if not smi or not smi.strip():
            raise ValueError("each element of smiles_list must be a non-empty string")

    if _API_KEY:
        predictions = await _screen_via_api(req.smiles_list)
    elif _MODEL_DIR.exists():
        predictions = await _screen_via_local(req.smiles_list)
    else:
        raise ValueError(
            "No ADMETlab backend configured: set ADMETLAB_API_KEY or ADMETLAB_MODEL_DIR"
        )

    return ScreenOut(predictions=predictions)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_admetlab.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
