"""mcp-lims-starlims — STARLIMS LIMS adapter (port 8014).

Endpoints:
- GET /test_results/{id}    — single LIMS test result by ID
- POST /query_results       — list test results matching filter criteria

Auth via STARLIMS_USER + STARLIMS_TOKEN environment variables.
The STARLIMS REST API uses Basic auth (user:token) for most on-prem deployments;
production can swap to OAuth2 by replacing _make_client() without touching the routes.
All upstream calls have a fixed timeout. Tests mock httpx.AsyncClient.
"""

from __future__ import annotations

import base64
import logging
import os
from typing import Annotated, Any

import httpx
from fastapi import Body, Path
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-lims-starlims")
settings = ToolSettings()

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
_STARLIMS_USER = os.environ.get("STARLIMS_USER", "")
_STARLIMS_TOKEN = os.environ.get("STARLIMS_TOKEN", "")
_STARLIMS_BASE_URL = os.environ.get(
    "STARLIMS_BASE_URL", "https://your-starlims-host/starlims/api/v1"
)
_HTTP_TIMEOUT = 15.0  # seconds


def _is_ready() -> bool:
    """Readyz: returns True only when auth credentials are configured."""
    return bool(_STARLIMS_USER and _STARLIMS_TOKEN)


app = create_app(
    name="mcp-lims-starlims",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
)


# --------------------------------------------------------------------------
# STARLIMS HTTP client (dependency-injected for testing)
# --------------------------------------------------------------------------
def _make_client() -> httpx.AsyncClient:
    creds = base64.b64encode(f"{_STARLIMS_USER}:{_STARLIMS_TOKEN}".encode()).decode()
    headers = {
        "Authorization": f"Basic {creds}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=_STARLIMS_BASE_URL,
        headers=headers,
        timeout=_HTTP_TIMEOUT,
    )


# Allow tests to inject a mock client by replacing this module-level factory.
_client_factory = _make_client


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------
class TestResult(BaseModel):
    id: str
    sample_id: str | None = None
    method_id: str | None = None
    analysis_name: str | None = None
    result_value: str | None = None
    result_unit: str | None = None
    status: str | None = None
    analyst: str | None = None
    completed_at: str | None = None
    raw_fields: dict[str, Any] = Field(default_factory=dict)


class QueryResultsRequest(BaseModel):
    sample_id: str | None = Field(None, description="Filter by sample ID.")
    method_id: str | None = Field(None, description="Filter by analytical method ID.")
    since: str | None = Field(
        None, description="ISO-8601 timestamp; return results completed after this time."
    )
    limit: int = Field(50, ge=1, le=500, description="Max results to return (1–500).")


class QueryResultsResponse(BaseModel):
    results: list[TestResult]
    total_count: int | None = None


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _parse_result(raw: dict[str, Any]) -> TestResult:
    """Normalize a raw STARLIMS test-result dict."""
    return TestResult(
        id=str(raw.get("ResultID", raw.get("id", ""))),
        sample_id=str(raw["SampleID"]) if raw.get("SampleID") else None,
        method_id=str(raw["MethodID"]) if raw.get("MethodID") else None,
        analysis_name=raw.get("AnalysisName"),
        result_value=str(raw["ResultValue"]) if raw.get("ResultValue") is not None else None,
        result_unit=raw.get("ResultUnit"),
        status=raw.get("Status"),
        analyst=raw.get("Analyst"),
        completed_at=raw.get("CompletedAt"),
        raw_fields={k: v for k, v in raw.items()},
    )


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/test_results/{result_id}", response_model=TestResult)
async def get_test_result(
    result_id: Annotated[str, Path(min_length=1, max_length=200)],
) -> TestResult:
    """Retrieve a single LIMS test result by its STARLIMS ID."""
    if not result_id.strip():
        raise ValueError("result_id must be a non-empty string")

    async with _client_factory() as client:
        resp = await client.get(f"/results/{result_id}")
        if resp.status_code == 404:
            raise ValueError(f"STARLIMS result not found: {result_id!r}")
        resp.raise_for_status()
        raw = resp.json()

    return _parse_result(raw)


@app.post("/query_results", response_model=QueryResultsResponse)
async def query_results(
    body: Annotated[QueryResultsRequest, Body()],
) -> QueryResultsResponse:
    """Query LIMS test results matching the given filter criteria."""
    payload: dict[str, Any] = {"limit": body.limit}
    if body.sample_id:
        payload["sampleId"] = body.sample_id
    if body.method_id:
        payload["methodId"] = body.method_id
    if body.since:
        payload["completedAfter"] = body.since

    async with _client_factory() as client:
        resp = await client.post("/results/query", json=payload)
        resp.raise_for_status()
        data = resp.json()

    raw_list = data if isinstance(data, list) else data.get("results", [])
    results = [_parse_result(r) for r in raw_list]
    return QueryResultsResponse(
        results=results,
        total_count=data.get("totalCount") if isinstance(data, dict) else len(results),
    )
