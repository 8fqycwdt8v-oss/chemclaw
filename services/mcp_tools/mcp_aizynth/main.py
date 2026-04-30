"""mcp-aizynth — AiZynthFinder retrosynthesis tree builder (port 8008).

Tools:
- POST /retrosynthesis — multi-step retrosynthesis tree search

AiZynthFinder requires pretrained policy networks and stock files.
The config YAML path must exist for /readyz to return 200.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Annotated, Any

from fastapi import Body
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-aizynth")
settings = ToolSettings()

_CONFIG_PATH = Path(
    os.environ.get("AIZYNTH_CONFIG", "/var/lib/mcp-aizynth/configs/config.yml")
)


def _is_ready() -> bool:
    return _CONFIG_PATH.exists() and _CONFIG_PATH.is_file()


app = create_app(
    name="mcp-aizynth",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_aizynth:invoke",
)


# ---------------------------------------------------------------------------
# Lazy AiZynthFinder import
# ---------------------------------------------------------------------------

def _get_finder(config_path: Path) -> Any:
    """Return an AiZynthFinder instance. Raises ImportError if not installed.

    Returns Any because aizynthfinder ships no stubs.
    """
    try:
        from aizynthfinder.aizynthfinder import AiZynthFinder  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError(
            "aizynthfinder package not installed; install it inside the Docker image"
        ) from exc
    finder = AiZynthFinder(configfile=str(config_path))
    return finder


# ---------------------------------------------------------------------------
# /retrosynthesis
# ---------------------------------------------------------------------------

class RetroRoute(BaseModel):
    tree: dict[str, Any]
    score: float = Field(ge=0.0)
    in_stock_ratio: float = Field(ge=0.0, le=1.0)


class AiZynthRetrosynthesisIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    max_iterations: int = Field(default=100, ge=1, le=1000)
    stocks: list[str] | None = Field(default=None, max_length=20)


class AiZynthRetrosynthesisOut(BaseModel):
    routes: list[RetroRoute]


@app.post("/retrosynthesis", response_model=AiZynthRetrosynthesisOut, tags=["aizynth"])
async def retrosynthesis(
    req: Annotated[AiZynthRetrosynthesisIn, Body(...)],
) -> AiZynthRetrosynthesisOut:
    if not req.smiles.strip():
        raise ValueError("smiles must be a non-empty string")

    finder = _get_finder(_CONFIG_PATH)

    if req.stocks:
        for stock_name in req.stocks:
            finder.stock.select(stock_name)

    finder.target_smiles = req.smiles
    finder.config.iteration_limit = req.max_iterations
    finder.prepare_tree()
    finder.tree_search()
    finder.build_routes()

    routes: list[RetroRoute] = []
    for stats in finder.routes.make_dicts():
        routes.append(
            RetroRoute(
                tree=stats.get("tree", {}),
                score=float(stats.get("score", 0.0)),
                in_stock_ratio=float(stats.get("in_stock_ratio", 0.0)),
            )
        )

    return AiZynthRetrosynthesisOut(routes=routes)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_aizynth.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
