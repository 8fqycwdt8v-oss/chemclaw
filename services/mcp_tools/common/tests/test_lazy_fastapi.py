"""Pin the lazy-import contract: importing `configure_logging` from
`services.mcp_tools.common` must NOT transitively import `fastapi`.

This guards projector containers (kg_documents, wiki_pages,
tool_result_extractor, etc.) which legitimately don't depend on FastAPI
and would crash-loop on startup if `services.mcp_tools.common` eagerly
imported `create_app` from `.app`.
"""
from __future__ import annotations

import importlib
import subprocess
import sys
import textwrap

import pytest


def test_configure_logging_import_does_not_pull_fastapi():
    """Run the import in a clean subprocess so we can verify `fastapi` is
    absent from `sys.modules` after the import completes. Doing this
    in-process would be polluted by the test runner itself importing
    fastapi for other suites."""
    script = textwrap.dedent(
        """
        import sys
        # Block fastapi at the import system level: if anything tries to
        # import it transitively, we get a clear ModuleNotFoundError
        # rather than a silent dependency on test-host state.
        sys.modules["fastapi"] = None
        from services.mcp_tools.common import configure_logging
        assert callable(configure_logging)
        # Verify fastapi was NOT pulled in. (Setting it to None above
        # would have made any `from fastapi import …` raise TypeError;
        # this assertion is belt-and-braces.)
        assert "fastapi" not in {m for m in sys.modules if sys.modules[m] is not None}, (
            "fastapi was imported transitively via services.mcp_tools.common; "
            "the lazy-import contract is broken."
        )
        print("OK")
        """
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, (
        f"subprocess failed:\nstdout={result.stdout}\nstderr={result.stderr}"
    )
    assert "OK" in result.stdout


def test_create_app_still_accessible_via_lazy_getattr():
    """Accessing `services.mcp_tools.common.create_app` must still work
    for the FastAPI-based MCP tool services that depend on the public
    API surface."""
    mod = importlib.import_module("services.mcp_tools.common")
    # Triggers __getattr__ → imports app lazily. Requires fastapi to be
    # installed in the test environment (it is — agent-claw test deps
    # pull it in).
    create_app = mod.create_app
    assert callable(create_app)


def test_missing_attribute_raises_attribute_error():
    """The __getattr__ fallback must raise AttributeError for unknown
    names, not silently return None."""
    mod = importlib.import_module("services.mcp_tools.common")
    with pytest.raises(AttributeError):
        _ = mod.nonexistent_helper
