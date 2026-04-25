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


class LocalSubprocessSandbox:
    """Runs Python in a local subprocess (for dev / CI).

    NOTE: This is NOT isolated.  Use E2B in production.
    """

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
