"""Backends for mcp-logs-sciy.

Two implementations sharing the schemas declared in ``main.py``:

- ``fake_postgres.FakePostgresBackend`` — reads the local ``fake_logs``
  Postgres schema. Used in dev + CI for hermetic testing.
- ``real_logs_sdk.RealLogsBackend`` — stub for future ``logs-python`` SDK
  integration against a live LOGS-by-SciY tenant. Raises
  ``NotImplementedError`` everywhere; landing this is gated on tenant
  access (see plan §11 Q1).
"""

from .fake_postgres import FakePostgresBackend
from .real_logs_sdk import RealLogsBackend

__all__ = ["FakePostgresBackend", "RealLogsBackend"]
