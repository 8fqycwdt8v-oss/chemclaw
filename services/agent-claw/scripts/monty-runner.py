#!/usr/bin/env python3
"""monty-runner.py — child-side runner for ChemClaw's code-mode orchestration.

Speaks the line-delimited JSON-RPC protocol from
services/agent-claw/src/runtime/monty/protocol.ts over stdio. The host
(agent-claw) spawns this script as a child, sends a Start frame, and the
runner executes the user-supplied Python while honouring two callbacks:

  external_function(name, args)  — round-trip to the host through the
                                   ExternalCallFrame / ExternalResponseFrame
                                   pair. Blocks the script until the host
                                   responds.

Two execution modes:

  1. MONTY MODE (preferred for production)
     If the `monty` Python package is importable, the runner uses
     `monty.Monty(code).run(...)` so the script runs inside the Rust-backed
     interpreter with resource limits, no third-party imports, and crash
     isolation via the panic-to-exit boundary.

  2. UNSAFE EXEC FALLBACK (development only)
     If `monty` is not installed AND the
     `MONTY_RUNNER_ALLOW_UNSAFE_EXEC=1` env var is set, the runner falls
     back to running the script via plain `exec()` in a fresh namespace.
     This is NOT a sandbox: a hostile script can read files, exhaust
     memory, or import third-party packages. The fallback exists so the
     full orchestration pipeline can be exercised in dev environments
     without the Rust binary; production must always run the Monty path.

Without either path available, the runner refuses to start and exits
immediately — failing fast is preferable to silently running un-sandboxed
LLM-authored code in production.

Frames flow:
  host → runner: start, external_response, shutdown
  runner → host: ready, external_call, log, result, error

Stdout is reserved for outgoing frames. The runner installs an
output-redirect that wraps any `print()` from the user script into a
LogFrame so unexpected stdout writes never corrupt the framing.
"""

from __future__ import annotations

import io
import json
import os
import sys
import threading
import traceback
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Wire helpers — line-delimited JSON over stdin/stdout.
# ---------------------------------------------------------------------------

# stdin / stdout we use for framing; the user script's prints go to a
# separate buffer that we fold into LogFrames.
_FRAME_IN = sys.stdin
_FRAME_OUT = sys.stdout
_LOCK = threading.Lock()


def _write_frame(frame: dict[str, Any]) -> None:
    """Emit one frame as a single line. Thread-safe via _LOCK."""
    encoded = json.dumps(frame, default=str)
    with _LOCK:
        _FRAME_OUT.write(encoded)
        _FRAME_OUT.write("\n")
        _FRAME_OUT.flush()


def _read_frame() -> dict[str, Any] | None:
    """Read one frame. Returns None on EOF."""
    line = _FRAME_IN.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return _read_frame()
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        # Drop malformed frames; the host's ZodSchema rejection on the
        # other direction means the protocol is best-effort tolerant.
        return _read_frame()


# ---------------------------------------------------------------------------
# external_function — round-trip a call to the host and block on the
# response. Each call gets a fresh monotonic id; the runner is single-
# threaded so a simple counter is enough.
# ---------------------------------------------------------------------------

_NEXT_CALL_ID = 0


def _call_external(name: str, args: Any) -> Any:
    global _NEXT_CALL_ID
    _NEXT_CALL_ID += 1
    call_id = _NEXT_CALL_ID
    _write_frame({
        "type": "external_call",
        "id": call_id,
        "name": name,
        "args": args,
    })
    while True:
        frame = _read_frame()
        if frame is None:
            raise RuntimeError("host closed stdin during external_function call")
        if frame.get("type") == "external_response" and frame.get("id") == call_id:
            if frame.get("ok"):
                return frame.get("value")
            raise RuntimeError(
                f"external_function('{name}') failed: {frame.get('error') or 'unknown error'}"
            )
        if frame.get("type") == "shutdown":
            raise RuntimeError("host shut down during external_function call")
        # Ignore unrelated frames (e.g. a stray external_response for a
        # different id) — the host shouldn't send those, but be defensive.


# ---------------------------------------------------------------------------
# Stdout capture — wrap user `print()` into LogFrames so the JSON-RPC
# framing on stdout is never corrupted. The user's stderr is captured
# similarly into LogFrames with stream="stderr".
# ---------------------------------------------------------------------------


class _StreamToFrames(io.TextIOBase):
    def __init__(self, stream: str) -> None:
        super().__init__()
        self._stream = stream
        self._buf = ""

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:  # type: ignore[override]
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            _write_frame({"type": "log", "stream": self._stream, "message": line})
        return len(s)

    def flush(self) -> None:
        if self._buf:
            _write_frame({
                "type": "log",
                "stream": self._stream,
                "message": self._buf,
            })
            self._buf = ""


# ---------------------------------------------------------------------------
# Execution backends.
# ---------------------------------------------------------------------------


def _try_import_monty() -> Any | None:
    try:
        import monty  # type: ignore  # noqa: I001
        return monty
    except ImportError:
        return None


def _run_via_monty(
    monty_mod: Any,
    script: str,
    inputs: dict[str, Any],
    expected_outputs: list[str],
    external_fn: Callable[[str, Any], Any],
) -> dict[str, Any]:
    """Execute the script using the real Monty Python binding.

    The exact API surface of monty is documented at github.com/pydantic/monty.
    This runner targets the documented `Monty(code).run(inputs, external_functions)`
    shape. If your Monty version exposes a different surface, update this
    function — protocol.ts on the host side is stable.
    """
    monty_obj = monty_mod.Monty(script)
    raw = monty_obj.run(
        inputs=inputs,
        external_functions={"external_function": external_fn},
    )
    return _harvest_outputs(raw, expected_outputs)


def _run_via_exec(
    script: str,
    inputs: dict[str, Any],
    expected_outputs: list[str],
    external_fn: Callable[[str, Any], Any],
) -> dict[str, Any]:
    """Unsafe dev fallback. Runs the script in a fresh namespace via exec()."""
    namespace: dict[str, Any] = {
        "__builtins__": __builtins__,
        "external_function": external_fn,
        **inputs,
    }
    exec(compile(script, "<monty_script>", "exec"), namespace, namespace)
    return _harvest_outputs(namespace, expected_outputs)


def _harvest_outputs(
    namespace: Any,
    expected_outputs: list[str],
) -> dict[str, Any]:
    """Pull each name in expected_outputs out of the namespace."""
    result: dict[str, Any] = {}
    if isinstance(namespace, dict):
        for name in expected_outputs:
            if name in namespace:
                result[name] = namespace[name]
    return result


# ---------------------------------------------------------------------------
# Main loop.
# ---------------------------------------------------------------------------


def _select_backend() -> Callable[..., dict[str, Any]] | None:
    monty_mod = _try_import_monty()
    if monty_mod is not None:
        def runner(
            script: str,
            inputs: dict[str, Any],
            expected_outputs: list[str],
            external_fn: Callable[[str, Any], Any],
        ) -> dict[str, Any]:
            return _run_via_monty(monty_mod, script, inputs, expected_outputs, external_fn)
        return runner
    if os.environ.get("MONTY_RUNNER_ALLOW_UNSAFE_EXEC") == "1":
        return _run_via_exec
    return None


def main() -> int:
    backend = _select_backend()
    if backend is None:
        sys.stderr.write(
            "monty-runner: no execution backend available. Install the "
            "`monty` Python package OR set MONTY_RUNNER_ALLOW_UNSAFE_EXEC=1 "
            "for the development fallback.\n"
        )
        return 2

    # Announce readiness — the host won't send Start until it sees this.
    _write_frame({"type": "ready", "child_version": "monty-runner.py/1"})

    while True:
        frame = _read_frame()
        if frame is None:
            return 0
        ftype = frame.get("type")
        if ftype == "shutdown":
            return 0
        if ftype != "start":
            # The host should send Start exactly once, then potentially
            # ExternalResponse frames during the run. Anything else is a
            # protocol error — quit so the host sees a child_crashed.
            sys.stderr.write(f"monty-runner: unexpected frame type '{ftype}'\n")
            return 3

        run_id = frame.get("run_id", "")
        script = frame.get("script", "")
        inputs = frame.get("inputs", {}) or {}
        expected_outputs = frame.get("expected_outputs", []) or []

        # Redirect user prints into LogFrames so the framing channel stays
        # clean even if the script writes to stdout/stderr directly.
        old_stdout, old_stderr = sys.stdout, sys.stderr
        sys.stdout = _StreamToFrames("stdout")  # type: ignore[assignment]
        sys.stderr = _StreamToFrames("stderr")  # type: ignore[assignment]
        try:
            outputs = backend(script, inputs, expected_outputs, _call_external)
            _write_frame({
                "type": "result",
                "run_id": run_id,
                "outputs": outputs,
            })
        except SystemExit:
            # exec() may raise SystemExit on user `sys.exit()` — surface
            # it as an error rather than a clean termination.
            tb = traceback.format_exc()
            _write_frame({
                "type": "error",
                "run_id": run_id,
                "error": "script called sys.exit",
                "traceback": tb,
            })
        except BaseException as exc:  # noqa: BLE001 — we want absolutely everything
            tb = traceback.format_exc()
            _write_frame({
                "type": "error",
                "run_id": run_id,
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": tb,
            })
        finally:
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            except Exception:  # noqa: BLE001
                pass
            sys.stdout, sys.stderr = old_stdout, old_stderr

        # Single-shot: each child handles exactly one Start. The pool
        # spawns a fresh child for the next run so namespace state from
        # the previous script can't leak into the next one.
        return 0


if __name__ == "__main__":
    sys.exit(main())
