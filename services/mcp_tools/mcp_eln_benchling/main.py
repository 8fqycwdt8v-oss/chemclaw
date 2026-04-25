"""mcp-eln-benchling — Benchling ELN adapter (port 8013).

Endpoints:
- GET /experiments/{id}    — single ELN entry by Benchling ID
- POST /query_runs         — list experiments matching filter criteria

Auth via BENCHLING_API_KEY environment variable.
All upstream calls have a fixed timeout. Tests mock httpx.AsyncClient.
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

log = logging.getLogger("mcp-eln-benchling")
settings = ToolSettings()

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
_BENCHLING_API_KEY = os.environ.get("BENCHLING_API_KEY", "")
_BENCHLING_BASE_URL = os.environ.get(
    "BENCHLING_BASE_URL", "https://your-tenant.benchling.com/api/v2"
)
_HTTP_TIMEOUT = 15.0  # seconds


def _is_ready() -> bool:
    """Readyz: returns True only when API key is configured."""
    return bool(_BENCHLING_API_KEY)


app = create_app(
    name="mcp-eln-benchling",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
)


# --------------------------------------------------------------------------
# Benchling HTTP client (dependency-injected for testing)
# --------------------------------------------------------------------------
def _make_client() -> httpx.AsyncClient:
    headers = {
        "Authorization": f"Bearer {_BENCHLING_API_KEY}",
        "Content-Type": "application/json",
    }
    return httpx.AsyncClient(
        base_url=_BENCHLING_BASE_URL,
        headers=headers,
        timeout=_HTTP_TIMEOUT,
    )


# Allow tests to inject a mock client by replacing this module-level factory.
_client_factory = _make_client


# --------------------------------------------------------------------------
# Schemas
# --------------------------------------------------------------------------
class AttachedFile(BaseModel):
    document_id: str
    original_uri: str


class ExperimentEntry(BaseModel):
    id: str
    schema_id: str
    fields: dict[str, Any]
    attached_files: list[AttachedFile] = Field(default_factory=list)
    created_at: str | None = None
    modified_at: str | None = None


class QueryRunsRequest(BaseModel):
    project_id: str | None = Field(None, description="Filter by Benchling project ID.")
    schema_id: str | None = Field(None, description="Filter by notebook entry schema ID.")
    since: str | None = Field(
        None, description="ISO-8601 timestamp; return entries modified after this time."
    )
    limit: int = Field(50, ge=1, le=200, description="Max entries to return (1–200).")


class QueryRunsResponse(BaseModel):
    entries: list[ExperimentEntry]
    next_page_token: str | None = None


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _parse_entry(raw: dict[str, Any]) -> ExperimentEntry:
    """Normalize a raw Benchling API entry dict."""
    attached = [
        AttachedFile(
            document_id=f.get("id", ""),
            original_uri=f.get("webURL", f.get("url", "")),
        )
        for f in raw.get("attachments", [])
    ]
    return ExperimentEntry(
        id=raw["id"],
        schema_id=raw.get("schema", {}).get("id", raw.get("schemaId", "")),
        fields=raw.get("fields", {}),
        attached_files=attached,
        created_at=raw.get("createdAt"),
        modified_at=raw.get("modifiedAt"),
    )


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/experiments/{entry_id}", response_model=ExperimentEntry)
async def get_experiment(
    entry_id: Annotated[str, Path(min_length=1, max_length=200)],
) -> ExperimentEntry:
    """Retrieve a single ELN notebook entry by its Benchling ID."""
    if not entry_id.strip():
        raise ValueError("entry_id must be a non-empty string")

    async with _client_factory() as client:
        resp = await client.get(f"/entries/{entry_id}")
        if resp.status_code == 404:
            raise ValueError(f"Benchling entry not found: {entry_id!r}")
        resp.raise_for_status()
        raw = resp.json()

    return _parse_entry(raw)


@app.post("/query_runs", response_model=QueryRunsResponse)
async def query_runs(
    body: Annotated[QueryRunsRequest, Body()],
) -> QueryRunsResponse:
    """Query ELN notebook entries matching the given filter criteria."""
    params: dict[str, Any] = {"pageSize": str(body.limit)}
    if body.project_id:
        params["projectId"] = body.project_id
    if body.schema_id:
        params["schemaId"] = body.schema_id
    if body.since:
        params["modifiedAt"] = f">{body.since}"

    async with _client_factory() as client:
        resp = await client.get("/entries", params=params)
        resp.raise_for_status()
        data = resp.json()

    entries = [_parse_entry(e) for e in data.get("entries", [])]
    return QueryRunsResponse(
        entries=entries,
        next_page_token=data.get("nextToken"),
    )
