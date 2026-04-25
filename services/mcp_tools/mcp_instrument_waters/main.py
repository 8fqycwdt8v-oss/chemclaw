"""mcp-instrument-waters — Waters Empower HPLC instrument adapter (port 8015).

Endpoints:
- GET /run/{id}        — single HPLC run with peaks
- POST /search_runs    — filter runs by date/sample/method

Auth via WATERS_API_KEY environment variable.
This adapter targets the Waters Empower Web Services REST API. In CSV-export mode,
swap _make_client() for a file-system reader without changing the route contracts.
All upstream calls have a fixed timeout. Tests mock httpx.AsyncClient.

See services/mcp_tools/mcp_instrument_template/README.md for how to fork this
adapter for other vendors (Agilent, Sciex, Thermo).
"""

from __future__ import annotations

import logging
import os
from typing import Annotated, Any

import httpx
from fastapi import Body, Path
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-instrument-waters")
settings = ToolSettings()

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
_WATERS_API_KEY = os.environ.get("WATERS_API_KEY", "")
_WATERS_BASE_URL = os.environ.get(
    "WATERS_BASE_URL", "https://your-empower-host/empower/api/v2"
)
_HTTP_TIMEOUT = 20.0  # HPLC APIs can be slow — generous timeout


def _is_ready() -> bool:
    """Readyz: returns True only when API key is configured."""
    return bool(_WATERS_API_KEY)


app = create_app(
    name="mcp-instrument-waters",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
)


# --------------------------------------------------------------------------
# Waters Empower HTTP client (dependency-injected for testing)
# --------------------------------------------------------------------------
def _make_client() -> httpx.AsyncClient:
    headers = {
        "X-API-Key": _WATERS_API_KEY,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=_WATERS_BASE_URL,
        headers=headers,
        timeout=_HTTP_TIMEOUT,
    )


# Allow tests to inject a mock client by replacing this module-level factory.
_client_factory = _make_client


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------
class ChromatographicPeak(BaseModel):
    peak_name: str | None = None
    retention_time_min: float
    area: float
    height: float | None = None
    area_pct: float | None = None
    resolution: float | None = None


class HplcRun(BaseModel):
    id: str
    sample_name: str | None = None
    method_name: str | None = None
    instrument_name: str | None = None
    run_date: str | None = None
    peaks: list[ChromatographicPeak] = Field(default_factory=list)
    total_area: float | None = None
    raw_fields: dict[str, Any] = Field(default_factory=dict)


class SearchRunsRequest(BaseModel):
    sample_name: str | None = Field(None, description="Filter by sample name (partial match).")
    method_name: str | None = Field(None, description="Filter by chromatographic method name.")
    date_from: str | None = Field(None, description="ISO-8601 date; return runs on or after this date.")
    date_to: str | None = Field(None, description="ISO-8601 date; return runs on or before this date.")
    limit: int = Field(50, ge=1, le=500, description="Max runs to return (1–500).")


class SearchRunsResponse(BaseModel):
    runs: list[HplcRun]
    total_count: int | None = None


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _parse_peak(raw: dict[str, Any]) -> ChromatographicPeak:
    return ChromatographicPeak(
        peak_name=raw.get("Name") or raw.get("PeakName"),
        retention_time_min=float(raw.get("RT", raw.get("RetentionTime", 0.0))),
        area=float(raw.get("Area", 0.0)),
        height=float(raw["Height"]) if raw.get("Height") is not None else None,
        area_pct=float(raw["AreaPct"]) if raw.get("AreaPct") is not None else None,
        resolution=float(raw["Resolution"]) if raw.get("Resolution") is not None else None,
    )


def _parse_run(raw: dict[str, Any]) -> HplcRun:
    peaks_raw = raw.get("peaks", raw.get("Peaks", []))
    peaks = [_parse_peak(p) for p in peaks_raw]
    total_area = sum(p.area for p in peaks) or None
    return HplcRun(
        id=str(raw.get("RunID", raw.get("id", ""))),
        sample_name=raw.get("SampleName"),
        method_name=raw.get("MethodName"),
        instrument_name=raw.get("InstrumentName"),
        run_date=raw.get("RunDate"),
        peaks=peaks,
        total_area=total_area,
        raw_fields=raw,
    )


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/run/{run_id}", response_model=HplcRun)
async def get_run(
    run_id: Annotated[str, Path(min_length=1, max_length=200)],
) -> HplcRun:
    """Retrieve a single HPLC run (with peaks) by its Empower run ID."""
    if not run_id.strip():
        raise ValueError("run_id must be a non-empty string")

    async with _client_factory() as client:
        resp = await client.get(f"/runs/{run_id}")
        if resp.status_code == 404:
            raise ValueError(f"Waters Empower run not found: {run_id!r}")
        resp.raise_for_status()
        raw = resp.json()

    return _parse_run(raw)


@app.post("/search_runs", response_model=SearchRunsResponse)
async def search_runs(
    body: Annotated[SearchRunsRequest, Body()],
) -> SearchRunsResponse:
    """Search HPLC runs matching date/sample/method criteria."""
    payload: dict[str, Any] = {"limit": body.limit}
    if body.sample_name:
        payload["sampleName"] = body.sample_name
    if body.method_name:
        payload["methodName"] = body.method_name
    if body.date_from:
        payload["dateFrom"] = body.date_from
    if body.date_to:
        payload["dateTo"] = body.date_to

    async with _client_factory() as client:
        resp = await client.post("/runs/search", json=payload)
        resp.raise_for_status()
        data = resp.json()

    raw_list = data if isinstance(data, list) else data.get("runs", [])
    runs = [_parse_run(r) for r in raw_list]
    return SearchRunsResponse(
        runs=runs,
        total_count=data.get("totalCount") if isinstance(data, dict) else len(runs),
    )
