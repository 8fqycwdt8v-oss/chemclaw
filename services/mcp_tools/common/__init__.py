"""Shared helpers for ChemClaw MCP tool services.

`create_app` is imported lazily via module-level `__getattr__` (PEP 562)
so that consumers needing only `configure_logging` (e.g. projector
containers under `services/projectors/`) don't pay the FastAPI import
cost — and don't crash with `ModuleNotFoundError: fastapi` when the
projector's `requirements.txt` legitimately omits the HTTP framework.

This is a deliberate split:
  * MCP tool services (FastAPI-based) reach `create_app` via this module
    or directly via `services.mcp_tools.common.app`.
  * Projectors (LISTEN/NOTIFY workers, no HTTP surface) reach only
    `configure_logging`, which has zero HTTP-framework dependencies.
"""

from services.mcp_tools.common.logging import configure_logging

__all__ = ["create_app", "configure_logging"]


def __getattr__(name: str):
    if name == "create_app":
        # Imported lazily so `import services.mcp_tools.common` (or
        # `from services.mcp_tools.common import configure_logging`)
        # does not transitively import fastapi.
        from services.mcp_tools.common.app import create_app

        return create_app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
