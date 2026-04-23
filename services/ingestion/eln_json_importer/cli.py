"""Command-line entrypoint for importing one ELN JSON file.

Usage:
  python -m services.ingestion.eln_json_importer.cli --input path/to/file.json
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import typer

from services.ingestion.eln_json_importer.importer import import_file

app = typer.Typer(add_completion=False)


@app.command()
def main(
    input: Path = typer.Option(
        ..., "--input", "-i", exists=True, file_okay=True, dir_okay=False,
        help="Path to an ELN JSON file to import."
    ),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    try:
        counters = import_file(input)
    except Exception as exc:
        typer.echo(f"import failed: {exc}", err=True)
        sys.exit(1)
    typer.echo(
        f"ok: {counters['experiments']} experiments, "
        f"{counters['reactions']} reactions imported."
    )


if __name__ == "__main__":
    app()
