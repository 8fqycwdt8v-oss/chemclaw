"""Tests for services/agent-claw/scripts/monty-runner.py.

The runner has two execution backends: real `monty` (Rust-backed
sandboxed interpreter) and unsafe `exec()` fallback. Existing
TS-side integration tests (services/agent-claw/tests/integration/
monty-runner.test.ts) exercise only the unsafe-exec path because real
`monty` isn't installed in CI. These tests stub `monty` via sys.modules
to verify _run_via_monty's call shape — the contract that the production
backend honours when the binding IS available.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

# monty-runner is a script, not a package; load it via importlib so the
# tests can invoke its private functions without restructuring the file
# (which would break the production stdio framing setup at import time
# if we inverted the flow).
_RUNNER_PATH = (
    Path(__file__).resolve().parents[2]
    / "services"
    / "agent-claw"
    / "scripts"
    / "monty-runner.py"
)


def _load_runner():
    spec = importlib.util.spec_from_file_location("_monty_runner", _RUNNER_PATH)
    if spec is None or spec.loader is None:
        pytest.skip(f"could not load monty-runner from {_RUNNER_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def runner():
    return _load_runner()


# ---------------------------------------------------------------------------
# _try_import_monty
# ---------------------------------------------------------------------------


class TestTryImportMonty:
    def test_returns_none_when_monty_not_installed(self, runner, monkeypatch):
        # The dev env doesn't have monty installed; the import returns
        # None so the runner can decide to fall back to exec.
        monkeypatch.delitem(sys.modules, "monty", raising=False)
        # _try_import_monty does `import monty` at call time; without
        # the package on the path, it returns None.
        assert runner._try_import_monty() is None

    def test_returns_module_when_monty_stub_in_sys_modules(self, runner, monkeypatch):
        stub = MagicMock(spec=["Monty"])
        monkeypatch.setitem(sys.modules, "monty", stub)
        assert runner._try_import_monty() is stub
        # Cleanup happens via monkeypatch teardown.


# ---------------------------------------------------------------------------
# _run_via_monty — call shape
# ---------------------------------------------------------------------------


class TestRunViaMonty:
    def test_constructs_monty_with_script_then_calls_run(self, runner):
        """The contract: monty.Monty(script).run(inputs=..., external_functions=...).

        If a future monty version changes this surface, update _run_via_monty
        — protocol.ts on the host side is stable.
        """
        # Stub Monty class: returns an instance whose .run() returns a
        # namespace dict with a couple of harvestable outputs.
        monty_instance = MagicMock()
        monty_instance.run.return_value = {
            "result_a": 42,
            "result_b": "hello",
            "_internal": "ignored",
        }
        monty_class = MagicMock(return_value=monty_instance)
        monty_mod = MagicMock()
        monty_mod.Monty = monty_class

        external_fn = MagicMock()
        out = runner._run_via_monty(
            monty_mod=monty_mod,
            script="x = 1",
            inputs={"a": 1, "b": 2},
            expected_outputs=["result_a", "result_b", "missing_one"],
            external_fn=external_fn,
        )

        # Construction: positional script.
        monty_class.assert_called_once_with("x = 1")
        # run() call: keyword inputs + external_functions dict containing
        # ONLY the documented `external_function` key.
        monty_instance.run.assert_called_once()
        kwargs = monty_instance.run.call_args.kwargs
        assert kwargs["inputs"] == {"a": 1, "b": 2}
        assert kwargs["external_functions"] == {"external_function": external_fn}
        # Harvest: only the names listed in expected_outputs flow back;
        # _internal is dropped, missing_one is silently absent.
        assert out == {"result_a": 42, "result_b": "hello"}

    def test_does_not_pass_internal_namespace_keys_to_external_functions(
        self, runner,
    ):
        # Defense-in-depth: the host should never see helper functions
        # the runner uses internally — only the documented external_function.
        monty_instance = MagicMock()
        monty_instance.run.return_value = {}
        monty_class = MagicMock(return_value=monty_instance)
        monty_mod = MagicMock()
        monty_mod.Monty = monty_class

        runner._run_via_monty(
            monty_mod=monty_mod,
            script="",
            inputs={},
            expected_outputs=[],
            external_fn=lambda name, args: None,
        )
        external_functions = monty_instance.run.call_args.kwargs[
            "external_functions"
        ]
        assert list(external_functions.keys()) == ["external_function"]


# ---------------------------------------------------------------------------
# _select_backend — backend selection precedence
# ---------------------------------------------------------------------------


class TestSelectBackend:
    def test_prefers_monty_when_available(self, runner, monkeypatch):
        stub_monty = MagicMock()
        stub_monty.Monty = MagicMock(return_value=MagicMock(run=MagicMock(return_value={})))
        monkeypatch.setattr(runner, "_try_import_monty", lambda: stub_monty)
        monkeypatch.delenv("MONTY_RUNNER_ALLOW_UNSAFE_EXEC", raising=False)

        backend = runner._select_backend()
        assert backend is not None
        # Run through it once; the inner _run_via_monty should construct
        # Monty(script). Verifies the closure binding is correct.
        backend("script-text", {}, [], lambda n, a: None)
        stub_monty.Monty.assert_called_once_with("script-text")

    def test_falls_back_to_exec_when_monty_unavailable_and_env_set(
        self, runner, monkeypatch,
    ):
        monkeypatch.setattr(runner, "_try_import_monty", lambda: None)
        monkeypatch.setenv("MONTY_RUNNER_ALLOW_UNSAFE_EXEC", "1")

        backend = runner._select_backend()
        # Backend is _run_via_exec — execute a trivial script to confirm.
        out = backend("x = 7", {}, ["x"], lambda n, a: None)
        assert out == {"x": 7}

    def test_refuses_to_select_when_monty_unavailable_and_env_unset(
        self, runner, monkeypatch,
    ):
        monkeypatch.setattr(runner, "_try_import_monty", lambda: None)
        monkeypatch.delenv("MONTY_RUNNER_ALLOW_UNSAFE_EXEC", raising=False)

        # Production-safe default: no backend → returns None so the
        # runner exits immediately rather than silently running un-
        # sandboxed code.
        assert runner._select_backend() is None
