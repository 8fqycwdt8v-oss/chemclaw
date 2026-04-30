"""mcp-sirius — SIRIUS 6 + CSI:FingerID + CANOPUS MS structure identification (port 8012).

Tools:
- POST /identify — identify an unknown compound from MS2 spectra

SIRIUS 6 is a JVM tool invoked via subprocess.run (shell=False).
/readyz returns 503 when the sirius binary is not on PATH.

Security:
- subprocess.run uses shell=False with an explicit arg list.
- All inputs validated by Pydantic before invoking the subprocess.
- Temporary directory cleaned up automatically.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-sirius")
settings = ToolSettings()

_SIRIUS_TIMEOUT = 120  # seconds


def _sirius_available() -> bool:
    return shutil.which("sirius") is not None


app = create_app(
    name="mcp-sirius",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_sirius_available,
    required_scope="mcp_sirius:invoke",
)


# ---------------------------------------------------------------------------
# subprocess helper
# ---------------------------------------------------------------------------

def _run_sirius(args: list[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    """Run sirius CLI with shell=False for security."""
    return subprocess.run(  # noqa: S603
        args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=_SIRIUS_TIMEOUT,
        shell=False,  # explicit — never shell=True
    )


# ---------------------------------------------------------------------------
# MS2 → MGF serialization
# ---------------------------------------------------------------------------

class Ms2Peak(BaseModel):
    m_z: float = Field(gt=0.0)
    intensity: float = Field(gt=0.0)


def _peaks_to_mgf(
    peaks: list[Ms2Peak],
    precursor_mz: float,
    ionization: str,
    compound_name: str = "unknown",
) -> str:
    """Serialize MS2 peaks to MGF format expected by SIRIUS."""
    mode = "+1" if ionization == "positive" else "-1"
    lines = [
        "BEGIN IONS",
        f"PEPMASS={precursor_mz:.6f}",
        f"CHARGE={mode}",
        f"FEATURE_ID=1",
        f"NAME={compound_name}",
    ]
    for peak in peaks:
        lines.append(f"{peak.m_z:.6f} {peak.intensity:.4f}")
    lines.append("END IONS")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# SIRIUS JSON result parsing
# ---------------------------------------------------------------------------

class ClassyFireResult(BaseModel):
    kingdom: str = ""
    superclass: str = ""
    class_: str = Field(default="", alias="class")

    model_config = {"populate_by_name": True}


class StructureCandidate(BaseModel):
    smiles: str
    name: str
    score: float
    classyfire: ClassyFireResult


def _parse_sirius_results(results_dir: Path) -> list[StructureCandidate]:
    """Parse SIRIUS formula_candidates.json and structure_candidates.json."""
    candidates: list[StructureCandidate] = []

    # Try the standard SIRIUS 6 output layout.
    structure_file = results_dir / "structure_candidates.json"
    if not structure_file.exists():
        # Older layout: search recursively.
        hits = list(results_dir.rglob("structure_candidates.json"))
        if not hits:
            return candidates
        structure_file = hits[0]

    try:
        data = json.loads(structure_file.read_text())
    except (json.JSONDecodeError, OSError):
        return candidates

    for entry in data:
        cf = entry.get("classyfireResult", {})
        candidates.append(
            StructureCandidate(
                smiles=entry.get("smiles", ""),
                name=entry.get("molecularFormula", entry.get("smiles", "")),
                score=float(entry.get("csiScore", 0.0)),
                classyfire=ClassyFireResult(
                    kingdom=cf.get("kingdom", {}).get("name", ""),
                    superclass=cf.get("superclass", {}).get("name", ""),
                    **{"class": cf.get("class", {}).get("name", "")},
                ),
            )
        )

    return sorted(candidates, key=lambda c: c.score, reverse=True)


# ---------------------------------------------------------------------------
# /identify
# ---------------------------------------------------------------------------

class IdentifyIn(BaseModel):
    ms2_peaks: list[Ms2Peak] = Field(min_length=1, max_length=5000)
    precursor_mz: float = Field(gt=0.0, le=10_000.0)
    ionization: Literal["positive", "negative"] = "positive"


class IdentifyOut(BaseModel):
    candidates: list[StructureCandidate]


@app.post("/identify", response_model=IdentifyOut, tags=["sirius"])
async def identify(
    req: Annotated[IdentifyIn, Body(...)],
) -> IdentifyOut:
    mgf_content = _peaks_to_mgf(req.ms2_peaks, req.precursor_mz, req.ionization)

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        input_mgf = tmp_path / "input.mgf"
        input_mgf.write_text(mgf_content)
        output_dir = tmp_path / "results"
        output_dir.mkdir()

        result = _run_sirius(
            [
                "sirius",
                "--input", str(input_mgf),
                "--output", str(output_dir),
                "formula",
                "structure",
                "canopus",
            ],
            cwd=tmp_path,
        )
        if result.returncode != 0:
            raise ValueError(
                f"sirius failed (exit {result.returncode}): {result.stderr[:500]}"
            )

        candidates = _parse_sirius_results(output_dir)

    return IdentifyOut(candidates=candidates)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_sirius.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
