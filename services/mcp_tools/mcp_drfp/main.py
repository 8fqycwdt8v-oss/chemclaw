"""mcp-drfp — Differential Reaction Fingerprint as a tool service.

DRFP (Probst et al., Digital Discovery 2022, 10.1039/D1DD00006C, MIT license)
computes a 2048-bit binary fingerprint from a reaction SMILES via the
symmetric difference of circular n-gram sets drawn from reagents and
products. It is data-independent and deterministic.

Tools:
- POST /tools/compute_drfp
"""

from __future__ import annotations

import logging
from typing import Annotated

from drfp import DrfpEncoder
from fastapi import Body
from pydantic import BaseModel, Field, field_validator

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_RXN_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-drfp")
settings = ToolSettings()
app = create_app(
    name="mcp-drfp",
    version="0.1.0",
    log_level=settings.log_level,
    required_scope="mcp_drfp:invoke",
)


class ComputeDrfpIn(BaseModel):
    rxn_smiles: str = Field(
        ...,
        description="Reaction SMILES with reagents>>products (or reagents>catalysts>products).",
        min_length=3,
        max_length=MAX_RXN_SMILES_LEN,
    )
    n_folded_length: int = Field(default=2048, ge=512, le=4096)
    radius: int = Field(default=3, ge=1, le=5)

    @field_validator("rxn_smiles")
    @classmethod
    def check_shape(cls, v: str) -> str:
        # The DRFP encoder wants reagents>reagents>products or reagents>>products.
        if ">" not in v:
            raise ValueError("rxn_smiles must contain '>' separators")
        return v.strip()


class ComputeDrfpOut(BaseModel):
    n_bits: int
    # 2048-bit fingerprint as a list of ints (0/1). Large but simple.
    vector: list[int]
    on_bit_count: int


@app.post("/tools/compute_drfp", response_model=ComputeDrfpOut, tags=["drfp"])
async def compute_drfp(req: Annotated[ComputeDrfpIn, Body(...)]) -> ComputeDrfpOut:
    try:
        # DrfpEncoder.encode returns a list of numpy arrays (one per input).
        fps = DrfpEncoder.encode(
            [req.rxn_smiles],
            n_folded_length=req.n_folded_length,
            radius=req.radius,
        )
    except Exception as exc:  # noqa: BLE001 — external library raises various types
        raise ValueError(f"DRFP encoding failed: {exc}") from exc

    if not fps or fps[0] is None:
        raise ValueError("DRFP produced no fingerprint — check reaction SMILES")

    bits = [int(b) for b in fps[0].tolist()]
    return ComputeDrfpOut(
        n_bits=req.n_folded_length,
        vector=bits,
        on_bit_count=sum(bits),
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_drfp.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
