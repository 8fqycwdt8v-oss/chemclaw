"""Domain types for mcp-embedder."""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

# Bounded to prevent DoS via extremely long single inputs. BGE-M3 has a
# max sequence length of 8192 tokens ≈ ~32K chars; we bound at 40K to leave
# headroom for non-english but reject obvious abuse.
_MAX_INPUT_CHARS = 40_000
_MAX_BATCH = 128

InputText = Annotated[str, StringConstraints(min_length=1, max_length=_MAX_INPUT_CHARS)]


class EmbedTextRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputs: Annotated[list[InputText], Field(min_length=1, max_length=_MAX_BATCH)]
    # Normalize to unit length — default True for cosine-distance store.
    normalize: bool = True


class EmbedTextResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: str
    dim: int
    vectors: list[list[float]]
