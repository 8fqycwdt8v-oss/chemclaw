"""Stub for the live LOGS-by-SciY backend (logs-python SDK).

Landing this is gated on a real LOGS tenant being available (plan §11 Q1).
For now every method raises ``NotImplementedError`` with a clear pointer to
the tenant-config requirement so callers fail loudly rather than silently
returning empty results.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any


_NOT_IMPLEMENTED_MSG = (
    "real LOGS backend requires logs-python SDK + tenant config; "
    "see plan §11 Q1"
)


class RealLogsBackend:
    """Placeholder for the live LOGS-by-SciY backend.

    The intended implementation will:
    - Authenticate to ``<tenant>.logs-sciy.com`` via OAuth or API key.
    - Call the LOGS REST endpoints / ``logs-python`` SDK to retrieve
      datasets, tracks, and persons.
    - Map vendor-shaped responses into the canonical ``LogsDataset`` /
      ``Track`` / ``Person`` Pydantic models declared in ``main.py``.

    For now everything is a stub.
    """

    def __init__(self, tenant_url: str | None = None, api_key: str | None = None) -> None:
        self.tenant_url = tenant_url
        self.api_key = api_key

    async def query_datasets(
        self,
        *,
        instrument_kind: list[str] | None = None,
        since: datetime | None = None,
        project_code: str | None = None,
        sample_name: str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def fetch_dataset(self, *, uid: str) -> dict[str, Any]:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def fetch_by_sample(self, *, sample_id: str) -> dict[str, Any]:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def query_persons(
        self,
        *,
        name_contains: str | None = None,
        limit: int = 50,
    ) -> dict[str, Any]:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)

    async def ready(self) -> bool:
        raise NotImplementedError(_NOT_IMPLEMENTED_MSG)
