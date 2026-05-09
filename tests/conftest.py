"""Pytest fixtures for the repo-root ``tests/`` namespace.

Mirrors ``services/mcp_tools/conftest.py``: declares dev-mode at
collection time so unit tests under ``tests/unit/`` that exercise
service routes via ``TestClient`` (e.g. mcp_tabicl, mcp_kg) don't hit
the closed-default auth middleware with 401.

Production code paths read the explicit env vars first; this fixture is
a no-op in any deploy that has already set them. See
``services/mcp_tools/conftest.py`` for the rationale.
"""

from __future__ import annotations

import os


def _enable_dev_mode() -> None:
    if "MCP_AUTH_REQUIRED" not in os.environ and "MCP_AUTH_DEV_MODE" not in os.environ:
        os.environ["MCP_AUTH_DEV_MODE"] = "true"
    os.environ.setdefault("MOCK_ELN_ALLOW_DEV_PASSWORD", "true")
    os.environ.setdefault("LOGS_ALLOW_DEV_PASSWORD", "true")
    os.environ.setdefault("CHEMCLAW_DEV_MODE", "true")


_enable_dev_mode()
