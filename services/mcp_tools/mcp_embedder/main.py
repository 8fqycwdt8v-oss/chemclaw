"""mcp-embedder — text → vector.

Tools:
- POST /tools/embed_text
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import Body

from services.mcp_tools.common.app import create_app
from services.mcp_tools.mcp_embedder.encoder import BGEM3Encoder, Encoder, StubEncoder
from services.mcp_tools.mcp_embedder.models import EmbedTextRequest, EmbedTextResponse
from services.mcp_tools.mcp_embedder.settings import EmbedderSettings

log = logging.getLogger("mcp-embedder")
settings = EmbedderSettings()

# Set HF cache dir if configured (supports air-gapped deployments).
if settings.hf_home:
    import os as _os
    _os.environ.setdefault("HF_HOME", settings.hf_home)


def _build_encoder() -> Encoder:
    if settings.embed_model_name == "stub-encoder":
        log.warning("Using stub encoder (dev-only — not semantic)")
        return StubEncoder()
    return BGEM3Encoder(settings.embed_model_name, settings.embed_device)


_encoder: Encoder = _build_encoder()


def _ready() -> bool:
    # Considered ready once encoder is instantiated. The first real encode
    # will trigger model download if needed; we don't block readiness on it
    # to allow k8s probes to pass while a big download is in progress.
    return _encoder is not None


app = create_app(
    name="mcp-embedder",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_ready,
    required_scope="mcp_embedder:invoke",
)


@app.post("/tools/embed_text", response_model=EmbedTextResponse, tags=["embedder"])
async def embed_text(req: Annotated[EmbedTextRequest, Body(...)]) -> EmbedTextResponse:
    try:
        vectors = _encoder.encode(req.inputs, normalize=req.normalize)
    except Exception as exc:  # noqa: BLE001 — encoder errors bubble here
        raise ValueError(f"embedding failed: {exc}") from exc

    if not vectors:
        raise ValueError("encoder returned no vectors")
    dim = len(vectors[0])
    if any(len(v) != dim for v in vectors):
        raise ValueError("encoder returned inconsistent vector dimensions")
    return EmbedTextResponse(
        model=_encoder.model_name,
        dim=dim,
        vectors=vectors,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_embedder.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
