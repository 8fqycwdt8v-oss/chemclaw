"""Sandbox client abstraction for forged-tool validation.

In production this wraps the E2B sandbox.
In tests the StubSandboxClient is injected instead.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import os
import json
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class SandboxResult:
    stdout: str
    stderr: str
    exit_code: int


class SandboxClient(Protocol):
    """Duck-typed interface expected by the validator."""

    def run_python(self, code: str, timeout_s: int = 20) -> SandboxResult:
        ...


_DEV_OPT_IN_ENV = "CHEMCLAW_ALLOW_LOCAL_SANDBOX"


class LocalSubprocessSandbox:
    """Runs Python in a local subprocess (for dev / CI ONLY).

    SECURITY: This sandbox provides NO isolation from the host process.
    LLM-authored code (forged-tool implementations) runs with the same
    permissions as the validator. In production this means the optimizer
    pod's service account, the database connection, and any mounted
    secrets are all reachable by the LLM-authored code.

    Production MUST use the E2B sandbox client. To use this class outside
    of unit tests, set the environment variable
    ``CHEMCLAW_ALLOW_LOCAL_SANDBOX=1`` to acknowledge the risk explicitly.
    The default refusal is fail-closed so a misconfigured deployment
    cannot silently fall back to running tool code locally.
    """

    def __init__(self) -> None:
        if os.environ.get(_DEV_OPT_IN_ENV) != "1":
            raise RuntimeError(
                "LocalSubprocessSandbox refuses to start: this sandbox "
                "provides no isolation from the host. "
                "Use E2BSandboxClient in production. "
                f"To use locally for development, set {_DEV_OPT_IN_ENV}=1."
            )

    def run_python(self, code: str, timeout_s: int = 20) -> SandboxResult:
        with tempfile.NamedTemporaryFile(suffix=".py", delete=False, mode="w") as f:
            f.write(code)
            tmppath = f.name

        try:
            result = subprocess.run(
                [sys.executable, tmppath],
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
            return SandboxResult(
                stdout=result.stdout,
                stderr=result.stderr,
                exit_code=result.returncode,
            )
        except subprocess.TimeoutExpired:
            return SandboxResult(stdout="", stderr="TimeoutExpired", exit_code=1)
        finally:
            os.unlink(tmppath)


class StubSandboxClient:
    """Deterministic stub for tests.

    Each call to run_python() returns the next pre-loaded result.
    If the queue is empty, returns a success result with empty output.
    """

    def __init__(self, results: list[SandboxResult] | None = None) -> None:
        self._results: list[SandboxResult] = list(results or [])

    def enqueue(self, result: SandboxResult) -> "StubSandboxClient":
        self._results.append(result)
        return self

    def run_python(self, code: str, timeout_s: int = 20) -> SandboxResult:  # noqa: ARG002
        if self._results:
            return self._results.pop(0)
        # Default: success with no output.
        return SandboxResult(stdout='{"__chemclaw_output__": {}}', stderr="", exit_code=0)
