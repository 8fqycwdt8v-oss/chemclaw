"""mcp-plate-designer — BoFire space-filling DoE for HTE plates (port 8020)."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, AsyncIterator

from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_RXN_SMILES_LEN, MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings
from services.mcp_tools.mcp_plate_designer import designer as _designer

log = logging.getLogger("mcp-plate-designer")
settings = ToolSettings()

_DATA_DIR = Path(os.environ.get(
    "MCP_PLATE_DESIGNER_DATA_DIR",
    str(Path(__file__).parent / "data"),
))

_CHEM21_FLOOR: set[str] = set()


def _is_ready() -> bool:
    return (_DATA_DIR / "chem21_solvents_v1.json").exists()


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global _CHEM21_FLOOR
    _CHEM21_FLOOR = _designer.load_chem21_floor(_DATA_DIR)
    yield


app = create_app(
    name="mcp-plate-designer",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_plate_designer:invoke",
    lifespan=_lifespan,
)


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------

class ContinuousFactor(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    type: str = Field(pattern="^continuous$")
    range: list[float] = Field(min_length=2, max_length=2)


class CategoricalInputSpec(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    values: list[str] = Field(min_length=1, max_length=200)


class Exclusions(BaseModel):
    solvents: list[str] = Field(default_factory=list, max_length=200)
    reagents: list[str] = Field(default_factory=list, max_length=200)


class DesignPlateIn(BaseModel):
    plate_format: str = Field(pattern="^(24|96|384|1536)$")
    reactants_smiles: str | None = Field(default=None, max_length=MAX_RXN_SMILES_LEN)
    product_smiles: str | None = Field(default=None, max_length=MAX_SMILES_LEN)
    factors: list[ContinuousFactor] = Field(default_factory=list, max_length=10)
    categorical_inputs: list[CategoricalInputSpec] = Field(default_factory=list, max_length=10)
    exclusions: Exclusions = Field(default_factory=Exclusions)
    n_wells: int = Field(ge=1, le=1536)
    seed: int = Field(default=42)
    disable_chem21_floor: bool = False

    @field_validator("reactants_smiles", "product_smiles")
    @classmethod
    def _no_reaction_arrow(cls, v: str | None) -> str | None:
        # These fields hold molecule SMILES, not reaction SMILES — accepting
        # `>>` would corrupt the f-string concat in designer.py:152 into a
        # double-arrow string and propagate to the ORD export.
        if v is not None and ">>" in v:
            raise ValueError(
                "must be a molecule SMILES, not a reaction SMILES (no '>>')"
            )
        return v


class WellOut(BaseModel):
    well_id: str
    rxn_smiles: str | None
    factor_values: dict[str, Any]


class DesignPlateOut(BaseModel):
    wells: list[WellOut]
    domain_json: dict[str, Any]
    design_metadata: dict[str, Any]


@app.post(
    "/design_plate",
    response_model=DesignPlateOut,
    tags=["plate_designer"],
)
async def design_plate(
    req: Annotated[DesignPlateIn, Body(...)],
) -> DesignPlateOut:
    if not req.factors and not req.categorical_inputs:
        raise HTTPException(
            status_code=422,
            detail="at least one factor or categorical_input must be provided",
        )

    try:
        result = _designer.design_plate(
            plate_format=req.plate_format,
            factors=[f.model_dump() for f in req.factors],
            categorical_inputs=[c.model_dump() for c in req.categorical_inputs],
            exclusions=req.exclusions.model_dump(),
            n_wells=req.n_wells,
            seed=req.seed,
            chem21_floor=_CHEM21_FLOOR,
            disable_chem21_floor=req.disable_chem21_floor,
            reactants_smiles=req.reactants_smiles,
            product_smiles=req.product_smiles,
        )
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("empty_categorical:"):
            raise HTTPException(status_code=422, detail=msg) from exc
        if msg.startswith("unknown plate_format"):
            raise HTTPException(status_code=422, detail=msg) from exc
        if "exceeds plate" in msg:
            raise HTTPException(status_code=422, detail=msg) from exc
        raise HTTPException(status_code=422, detail=f"infeasible_domain: {msg}") from exc
    return DesignPlateOut(**result)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_plate_designer.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
