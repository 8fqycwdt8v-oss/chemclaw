"""Top-level Typer application."""

from __future__ import annotations

import typer

from chemclaw_cli import __version__
from chemclaw_cli.commands.chat import chat as chat_command

app = typer.Typer(
    name="chemclaw",
    help="Minimal CLI for the ChemClaw agent (agent-claw /api/chat).",
    no_args_is_help=True,
    add_completion=True,
)

app.command("chat")(chat_command)


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(f"chemclaw {__version__}")
        raise typer.Exit(code=0)


@app.callback()
def _root(
    version: bool = typer.Option(
        False,
        "--version",
        callback=_version_callback,
        is_eager=True,
        help="Print version and exit.",
    ),
) -> None:
    """Root callback — exists to host --version."""
