"""`chemclaw chat` — single-shot streamed chat against agent-claw."""

from __future__ import annotations

import json
from typing import Optional

import httpx
import typer
from rich.console import Console

from chemclaw_cli.config import load_config
from chemclaw_cli.session_store import SessionStore
from chemclaw_cli.sse import parse_sse_lines

# Exit codes (also documented in tools/cli/README.md).
EXIT_OK = 0
EXIT_SERVER_ERROR = 1
EXIT_AWAITING_INPUT = 2
EXIT_CONNECT_ERROR = 3
EXIT_AUTH_REJECTED = 4
EXIT_RESUME_NO_SESSION = 5

_stderr = Console(stderr=True)
_stdout = Console()


def chat(
    prompt: str = typer.Argument(..., help="The user message to send."),
    resume: bool = typer.Option(
        False,
        "--resume",
        "-r",
        help="Continue the most recent session for $CHEMCLAW_USER.",
    ),
    session: Optional[str] = typer.Option(
        None,
        "--session",
        "-s",
        help="Continue a specific session UUID. Overrides --resume.",
    ),
    verbose: bool = typer.Option(
        False,
        "--verbose",
        "-v",
        help="Show session, todo, tool, plan events too.",
    ),
) -> None:
    """Send a single user message; stream the agent's response."""
    cfg = load_config()
    store = SessionStore(config_dir=cfg.config_dir)

    session_id: Optional[str] = session
    if session_id is None and resume:
        session_id = store.read(cfg.user)
        if session_id is None:
            _stdout.print(f'no saved session for user "{cfg.user}" — start a new chat first')
            raise typer.Exit(code=EXIT_RESUME_NO_SESSION)

    body: dict = {"messages": [{"role": "user", "content": prompt}]}
    if session_id is not None:
        body["session_id"] = session_id

    headers = {
        "content-type": "application/json",
        "accept": "text/event-stream",
        "x-user-entra-id": cfg.user,
    }
    url = f"{cfg.agent_url}/api/chat"

    if verbose:
        _stderr.print(f"[dim]→ POST {url} (user={cfg.user})[/dim]")

    try:
        with httpx.Client(
            timeout=httpx.Timeout(connect=10.0, read=None, write=10.0, pool=10.0)
        ) as client:
            with client.stream("POST", url, json=body, headers=headers) as response:
                if response.status_code in (401, 403):
                    response.read()
                    _stdout.print(
                        f'auth rejected; check $CHEMCLAW_USER (currently "{cfg.user}")'
                    )
                    raise typer.Exit(code=EXIT_AUTH_REJECTED)
                if response.status_code >= 400:
                    response.read()
                    snippet = response.text[:500]
                    rid = response.headers.get("x-request-id", "")
                    if rid:
                        _stderr.print(
                            f"[dim](server request_id: {rid} — include in bug reports)[/dim]"
                        )
                    _stdout.print(snippet)
                    raise typer.Exit(code=EXIT_SERVER_ERROR)

                if verbose:
                    rid = response.headers.get("x-request-id", "")
                    if rid:
                        _stderr.print(f"[dim]server request_id: {rid}[/dim]")

                exit_code = _consume_stream(response, store=store, user=cfg.user, verbose=verbose)
                raise typer.Exit(code=exit_code)
    except httpx.ConnectError:
        _stdout.print(
            f'agent-claw not reachable at {cfg.agent_url}; is "make up" running?'
        )
        raise typer.Exit(code=EXIT_CONNECT_ERROR) from None
    except KeyboardInterrupt:
        _stdout.print("[yellow][interrupted][/yellow]")
        raise typer.Exit(code=130) from None


def _consume_stream(
    response: httpx.Response,
    *,
    store: SessionStore,
    user: str,
    verbose: bool,
) -> int:
    """Drive the SSE loop. Returns the exit code to use."""
    saw_text = False

    for event in parse_sse_lines(response.iter_lines()):
        if not isinstance(event, dict):
            continue
        etype = event.get("type")

        if etype == "text_delta":
            delta = event.get("delta", "")
            _stdout.print(delta, end="", soft_wrap=True, markup=False, highlight=False)
            saw_text = True
            continue

        if etype == "session":
            sid = event.get("session_id")
            if sid:
                store.write(user, sid)
            if verbose:
                _stderr.print(f"[dim]session: {sid}[/dim]")
            continue

        if etype == "awaiting_user_input":
            sid = event.get("session_id")
            if sid:
                store.write(user, sid)
            question = event.get("question", "")
            if saw_text:
                _stdout.print()
            _stdout.print(f"[yellow]❓ {question}[/yellow]")
            return EXIT_AWAITING_INPUT

        if etype == "error":
            err = event.get("error", "<unknown error>")
            # The error frame now carries optional request_id / trace_id
            # alongside the legacy `error` code (additive shape — see
            # services/agent-claw/src/streaming/sse.ts). Surfacing both
            # to the user makes a streaming failure traceable in Loki +
            # Langfuse without needing the server-log access role.
            rid = event.get("request_id")
            tid = event.get("trace_id")
            if saw_text:
                _stdout.print()
            _stdout.print(f"[red]{err}[/red]")
            if rid or tid:
                parts = []
                if rid:
                    parts.append(f"request_id={rid}")
                if tid:
                    parts.append(f"trace_id={tid}")
                _stderr.print(f"[dim]({' · '.join(parts)})[/dim]")
            return EXIT_SERVER_ERROR

        if etype == "finish":
            if saw_text:
                _stdout.print()
            if verbose:
                reason = event.get("finishReason", "?")
                usage = event.get("usage", {})
                _stderr.print(f"[dim]{reason} · {usage}[/dim]")
            return EXIT_OK

        if verbose:
            if etype == "todo_update":
                for todo in event.get("todos", []):
                    mark = {"done": "✓", "in_progress": "•", "pending": " "}.get(
                        todo.get("status", ""), "?"
                    )
                    _stderr.print(f"[dim]{mark} {todo.get('content', '')}[/dim]")
            elif etype == "tool_call":
                _stderr.print(
                    f"[dim]→ {event.get('toolId')}({_truncate(event.get('input'))})[/dim]"
                )
            elif etype == "tool_result":
                _stderr.print(f"[dim]← {_truncate(event.get('output'))}[/dim]")
            elif etype in ("plan_step", "plan_ready"):
                _stderr.print(f"[dim]plan: {etype}[/dim]")
            else:
                _stderr.print(f"[dim]?? {etype}[/dim]")

    # Stream ended without `finish`. Treat as success — the connection
    # may have closed cleanly mid-emit on a fast small reply.
    if saw_text:
        _stdout.print()
    return EXIT_OK


def _truncate(value: object, limit: int = 120) -> str:
    s = json.dumps(value, default=str) if not isinstance(value, str) else value
    return s if len(s) <= limit else s[: limit - 1] + "…"
