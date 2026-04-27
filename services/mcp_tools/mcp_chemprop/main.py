"""mcp-chemprop — chemprop v2 MPNN yield/property prediction (port 8009).

Tools:
- POST /predict_yield    — reaction yield prediction with uncertainty
- POST /predict_property — molecular property prediction (logP, logS, mp, bp)

Pretrained model directory at /var/lib/mcp-chemprop/models/ must exist.
chemprop is NOT installed in the dev .venv; it is installed in the Dockerfile.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_BATCH_SMILES, MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-chemprop")
settings = ToolSettings()

_MODEL_DIR = Path(os.environ.get("CHEMPROP_MODEL_DIR", "/var/lib/mcp-chemprop/models"))

_PROPERTY_MODEL_MAP: dict[str, str] = {
    "logP": "logp_model",
    "logS": "logs_model",
    "mp":   "mp_model",
    "bp":   "bp_model",
}


def _is_ready() -> bool:
    return _MODEL_DIR.exists() and _MODEL_DIR.is_dir()


app = create_app(
    name="mcp-chemprop",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_chemprop:invoke",
)


# ---------------------------------------------------------------------------
# Lazy chemprop import
# ---------------------------------------------------------------------------

def _chemprop_predict(smiles_list: list[str], model_path: Path) -> list[tuple[float, float]]:
    """Return (mean, std) per SMILES."""
    try:
        from chemprop import data as cp_data  # type: ignore[import]  # noqa: PLC0415
        from chemprop.models import MPNN  # type: ignore[import]  # noqa: PLC0415
        import torch  # type: ignore[import]  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError(
            "chemprop package not installed; install it inside the Docker image"
        ) from exc

    model = MPNN.load_from_file(str(model_path))
    dataset = cp_data.MoleculeDataset(
        [cp_data.MoleculeDatapoint.from_smi(smi) for smi in smiles_list]
    )
    loader = cp_data.build_dataloader(dataset, shuffle=False)

    preds_list: list[torch.Tensor] = []
    with torch.no_grad():
        for batch in loader:
            preds_list.append(model(batch.bmg, batch.V_d, batch.X_d, batch.Y))

    preds = torch.cat(preds_list, dim=0)
    means = preds[:, 0].tolist()
    stds = preds[:, 1].tolist() if preds.shape[1] > 1 else [0.0] * len(means)
    return list(zip(means, stds))


# ---------------------------------------------------------------------------
# /predict_yield
# ---------------------------------------------------------------------------

_MAX_REACTIONS = MAX_BATCH_SMILES

class YieldPrediction(BaseModel):
    rxn_smiles: str
    predicted_yield: float
    std: float
    model_id: str


_BoundedSmiles = Annotated[
    str, Field(min_length=1, max_length=MAX_SMILES_LEN, description="SMILES string"),
]


class PredictYieldIn(BaseModel):
    # Per-element bound (10k chars) prevents a 10 MB SMILES from sneaking
    # past the list-level cap and OOM'ing the chemprop loader.
    rxn_smiles_list: list[_BoundedSmiles] = Field(min_length=1, max_length=_MAX_REACTIONS)


class PredictYieldOut(BaseModel):
    predictions: list[YieldPrediction]


@app.post("/predict_yield", response_model=PredictYieldOut, tags=["chemprop"])
async def predict_yield(
    req: Annotated[PredictYieldIn, Body(...)],
) -> PredictYieldOut:
    if not req.rxn_smiles_list:
        raise ValueError("rxn_smiles_list must not be empty")
    if len(req.rxn_smiles_list) > _MAX_REACTIONS:
        raise ValueError(f"rxn_smiles_list length exceeds max {_MAX_REACTIONS}")

    model_path = _MODEL_DIR / "yield_model"
    results = _chemprop_predict(req.rxn_smiles_list, model_path)

    predictions = [
        YieldPrediction(
            rxn_smiles=rxn_smiles,
            predicted_yield=float(mean),
            std=float(std),
            model_id="yield_model@v1",
        )
        for rxn_smiles, (mean, std) in zip(req.rxn_smiles_list, results)
    ]
    return PredictYieldOut(predictions=predictions)


# ---------------------------------------------------------------------------
# /predict_property
# ---------------------------------------------------------------------------

_MAX_SMILES = MAX_BATCH_SMILES

class PropertyPrediction(BaseModel):
    smiles: str
    value: float
    std: float


class PredictPropertyIn(BaseModel):
    smiles_list: list[_BoundedSmiles] = Field(min_length=1, max_length=_MAX_SMILES)
    property: Literal["logP", "logS", "mp", "bp"]


class PredictPropertyOut(BaseModel):
    predictions: list[PropertyPrediction]


@app.post("/predict_property", response_model=PredictPropertyOut, tags=["chemprop"])
async def predict_property(
    req: Annotated[PredictPropertyIn, Body(...)],
) -> PredictPropertyOut:
    if not req.smiles_list:
        raise ValueError("smiles_list must not be empty")

    model_name = _PROPERTY_MODEL_MAP[req.property]
    model_path = _MODEL_DIR / model_name
    results = _chemprop_predict(req.smiles_list, model_path)

    predictions = [
        PropertyPrediction(smiles=smi, value=float(mean), std=float(std))
        for smi, (mean, std) in zip(req.smiles_list, results)
    ]
    return PredictPropertyOut(predictions=predictions)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_chemprop.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
