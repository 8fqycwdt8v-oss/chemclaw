"""CLI entrypoint for doc_ingester."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import typer

from services.ingestion.doc_ingester.importer import ingest_file, scan_and_ingest
from services.ingestion.doc_ingester.settings import IngesterSettings

app = typer.Typer(add_completion=False)


@app.command()
def one(
    path: Path = typer.Option(
        ..., "--path", "-p", exists=True, file_okay=True, dir_okay=False,
        help="Path to a single document (must be inside docs_root).",
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    _configure_logging(verbose)
    try:
        result = ingest_file(path)
    except Exception as exc:
        typer.echo(f"ingest failed: {exc}", err=True)
        sys.exit(1)
    typer.echo(f"ok: {result}")


@app.command()
def scan(
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    _configure_logging(verbose)
    settings = IngesterSettings()
    typer.echo(f"scanning {settings.docs_root} ...")
    results = scan_and_ingest(settings)
    ingested = sum(1 for r in results if r["status"] == "ingested")
    skipped = sum(1 for r in results if r["status"] == "already_ingested")
    typer.echo(f"ok: {ingested} ingested, {skipped} already present, total {len(results)}.")


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


if __name__ == "__main__":
    app()
