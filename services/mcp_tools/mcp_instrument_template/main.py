"""mcp-instrument-template — runnable skeleton for vendor instrument adapters.

THIS IS A TEMPLATE. It runs (returns 501s with explanatory bodies on every
content endpoint) so a developer can `docker compose up` and verify the
plumbing works end-to-end before swapping in real vendor calls. It is NOT
wired into `docker-compose.yml`; copy the directory to
`services/mcp_tools/mcp_instrument_<vendor>/` first and follow the README.

What this skeleton demonstrates:
  - `create_app(...)` from `services.mcp_tools.common.app` so /healthz,
    /readyz, request-ID middleware, and the {error, detail} envelope are
    inherited.
  - Pydantic models for the two stable endpoints (`/run/{run_id}` and
    `/search_runs`) — the contract that every instrument adapter must
    satisfy so the agent builtin can stay vendor-agnostic.
  - Strict regex on the run_id path parameter — closes path-traversal /
    upstream-URL injection.
  - A 501 body that explains how to wire the real client, instead of an
    opaque `not implemented`.

Replace the contents of `_fetch_run` and `_search_runs` with vendor calls
and the skeleton becomes a real adapter. Keep the response shapes.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app


log = logging.getLogger("mcp-instrument-template")

# Strict ID regex — anchors prevent path traversal when the upstream URL
# is constructed via string concatenation.
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_\-\.]{1,128}$")


class ChromatographicPeak(BaseModel):
    rt_min: float = Field(..., description="Retention time in minutes")
    area_units: float
    height_units: float
    name: str | None = None
    m_z: float | None = None


class HplcRun(BaseModel):
    id: str
    sample_name: str | None = None
    method_name: str | None = None
    run_started_at: str | None = Field(None, description="ISO-8601 UTC")
    peaks: list[ChromatographicPeak]


class SearchRunsRequest(BaseModel):
    sample_name: str | None = None
    method_name: str | None = None
    date_from: str | None = Field(None, description="ISO-8601 UTC")
    date_to: str | None = Field(None, description="ISO-8601 UTC")
    page: int = Field(1, ge=1)
    page_size: int = Field(50, ge=1, le=500)


class SearchRunsResponse(BaseModel):
    runs: list[HplcRun]
    total: int


def _not_implemented(detail: str) -> HTTPException:
    return HTTPException(
        status_code=501,
        detail={
            "error": "not_implemented",
            "detail": (
                f"{detail} — replace _fetch_run/_search_runs in main.py with "
                "your vendor's client calls and remove this 501 body."
            ),
        },
    )


async def _fetch_run(run_id: str) -> HplcRun:
    raise _not_implemented(f"fetch_run({run_id}) not wired")


async def _search_runs(req: SearchRunsRequest) -> SearchRunsResponse:
    raise _not_implemented("search_runs not wired")


app = create_app(name="mcp-instrument-template", version="0.0.0-template")


@app.get("/run/{run_id}", response_model=HplcRun)
async def get_run(run_id: str) -> HplcRun:
    if not _RUN_ID_RE.match(run_id):
        raise HTTPException(
            status_code=400,
            detail={"error": "invalid_run_id", "detail": "run_id must match ^[A-Za-z0-9_\\-\\.]{1,128}$"},
        )
    return await _fetch_run(run_id)


@app.post("/search_runs", response_model=SearchRunsResponse)
async def search_runs(req: SearchRunsRequest) -> SearchRunsResponse:
    return await _search_runs(req)


def main() -> None:
    """Local-dev entrypoint — `python -m services.mcp_tools.mcp_instrument_template.main`.

    Production deploys run via `uvicorn services.mcp_tools.mcp_instrument_template.main:app`
    (or whatever vendor-suffixed module the template was copied to).
    """
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8013)


if __name__ == "__main__":  # pragma: no cover — local-dev only
    main()
