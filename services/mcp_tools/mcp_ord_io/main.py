"""mcp-ord-io — ORD protobuf import/export (port 8021).

Stateless wire-format conversion. No chemistry validation; assumes upstream
canonicalization (mcp-rdkit) has already happened.
"""
from __future__ import annotations

import base64
import logging
from contextlib import asynccontextmanager
from typing import Annotated, Any, AsyncIterator

from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-ord-io")
settings = ToolSettings()


def _ord_schema_loadable() -> bool:
    try:
        import ord_schema  # noqa: F401, PLC0415
        return True
    except ImportError:
        return False


def _is_ready() -> bool:
    return _ord_schema_loadable()


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield


app = create_app(
    name="mcp-ord-io",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_ord_io:invoke",
    lifespan=_lifespan,
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class WellInput(BaseModel):
    well_id: str
    rxn_smiles: str | None = None
    factor_values: dict[str, Any] = Field(default_factory=dict)


class ExportIn(BaseModel):
    plate_name: str = Field(default="plate", min_length=1, max_length=200)
    reactants_smiles: str | None = None
    product_smiles: str | None = None
    wells: list[WellInput] = Field(min_length=1, max_length=2000)


class ExportOut(BaseModel):
    ord_protobuf_b64: str
    n_reactions: int
    summary: dict[str, Any]


class ImportIn(BaseModel):
    ord_protobuf_b64: str = Field(min_length=1, max_length=10_000_000)


class ImportOut(BaseModel):
    plate_name: str
    n_reactions: int
    reactions: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# /export
# ---------------------------------------------------------------------------
@app.post("/export", response_model=ExportOut, tags=["ord_io"])
async def export_ord(req: Annotated[ExportIn, Body(...)]) -> ExportOut:
    try:
        from ord_schema.proto import dataset_pb2, reaction_pb2  # noqa: PLC0415
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="ord_schema unavailable") from exc

    dataset = dataset_pb2.Dataset(name=req.plate_name)
    for well in req.wells:
        rxn = reaction_pb2.Reaction()
        rxn.notes.procedure_details = f"well={well.well_id}"
        # Identifiers — reaction SMILES if supplied
        if well.rxn_smiles or req.reactants_smiles or req.product_smiles:
            rxn_id = rxn.identifiers.add()
            rxn_id.type = reaction_pb2.ReactionIdentifier.REACTION_SMILES
            rxn_id.value = (
                well.rxn_smiles
                or f"{req.reactants_smiles or ''}>>{req.product_smiles or ''}"
            )
        # Factor values: serialize categorical → ReactionInput, continuous → ReactionConditions
        for k, v in well.factor_values.items():
            if isinstance(v, (int, float)):
                if k.lower().startswith("temp"):
                    rxn.conditions.temperature.setpoint.value = float(v)
                    rxn.conditions.temperature.setpoint.units = (
                        reaction_pb2.Temperature.CELSIUS
                    )
                else:
                    rxn.notes.procedure_details += f"; {k}={v}"
            else:
                # Categorical: render as a free-text input note. Real wiring
                # to ReactionInput.compounds requires SMILES per category;
                # users wanting structural fidelity should pre-canonicalize.
                rxn.notes.procedure_details += f"; {k}={v}"
        dataset.reactions.append(rxn)

    blob = dataset.SerializeToString()
    return ExportOut(
        ord_protobuf_b64=base64.b64encode(blob).decode("ascii"),
        n_reactions=len(req.wells),
        summary={
            "plate_name": req.plate_name,
            "n_reactions": len(req.wells),
            "bytes": len(blob),
        },
    )


# ---------------------------------------------------------------------------
# /import
# ---------------------------------------------------------------------------
@app.post("/import", response_model=ImportOut, tags=["ord_io"])
async def import_ord(req: Annotated[ImportIn, Body(...)]) -> ImportOut:
    try:
        from ord_schema.proto import dataset_pb2, reaction_pb2  # noqa: PLC0415
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="ord_schema unavailable") from exc

    try:
        blob = base64.b64decode(req.ord_protobuf_b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid_base64: {exc}") from exc

    dataset = dataset_pb2.Dataset()
    try:
        dataset.ParseFromString(blob)
    except Exception as exc:  # noqa: BLE001 — protobuf parse can throw various
        raise HTTPException(status_code=400, detail=f"invalid_protobuf: {exc}") from exc

    rxn_smiles_enum = reaction_pb2.ReactionIdentifier.REACTION_SMILES
    reactions: list[dict[str, Any]] = []
    for rxn in dataset.reactions:
        rxn_smiles = next(
            (i.value for i in rxn.identifiers if i.type == rxn_smiles_enum),
            None,
        )
        # Gate on message presence, NOT on truthiness of the value.
        # 0.0 °C (cryogenic) is a physically valid setpoint that must round-trip.
        temp_c: float | None = None
        try:
            if rxn.conditions.HasField("temperature"):
                temp_c = float(rxn.conditions.temperature.setpoint.value)
        except ValueError:
            # ord-schema versions where scalar HasField raises: fall back to
            # the nested setpoint message presence (proto3 sub-messages always
            # support HasField).
            if rxn.conditions.temperature.HasField("setpoint"):
                temp_c = float(rxn.conditions.temperature.setpoint.value)
        reactions.append({
            "rxn_smiles": rxn_smiles,
            "procedure_details": rxn.notes.procedure_details,
            "temperature_c": temp_c,
        })

    return ImportOut(
        plate_name=dataset.name,
        n_reactions=len(reactions),
        reactions=reactions,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_ord_io.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
