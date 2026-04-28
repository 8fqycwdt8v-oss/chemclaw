"""Pytest fixtures shared across MCP service tests.

Two cycle-1+2 security defaults need to be acknowledged for tests to run
without setting up real auth + a real DB password:

  1. The auth middleware in `services/mcp_tools/common/app.py` fails
     CLOSED by default — production deploys that forget to set the auth
     env shouldn't silently accept unsigned requests. Test suites that
     exercise route handlers via Starlette's TestClient don't carry a
     JWT, so they hit 401 unless the service is told this is a dev/test
     run via `MCP_AUTH_DEV_MODE=true`.

  2. mcp_eln_local and mcp_logs_sciy refuse to start when the configured
     DSN/password contains the dev sentinel and the operator hasn't set
     `MOCK_ELN_ALLOW_DEV_PASSWORD=true` / `LOGS_ALLOW_DEV_PASSWORD=true`.
     Test fixtures use the sentinel by design (they monkeypatch the
     backend), so we acknowledge dev usage here.

Setting these at *collection* time (before any service module is imported)
declares intent without changing per-test boilerplate. Production code
paths read the explicit env vars first, so this fixture is a no-op in
any deploy that has already set them.
"""

from __future__ import annotations

import os


def _enable_dev_mode() -> None:
    # Don't override an explicit caller setting — let CI / a custom
    # `pytest -s` run that wants to test the closed-default path do so.
    if "MCP_AUTH_REQUIRED" not in os.environ and "MCP_AUTH_DEV_MODE" not in os.environ:
        os.environ["MCP_AUTH_DEV_MODE"] = "true"
    os.environ.setdefault("MOCK_ELN_ALLOW_DEV_PASSWORD", "true")
    os.environ.setdefault("LOGS_ALLOW_DEV_PASSWORD", "true")


_enable_dev_mode()
