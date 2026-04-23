"""Error-policy tests for chunk_embedder mirroring reaction_vectorizer's contract:
4xx ⇒ permanent (ack + skip), 5xx/network ⇒ transient (propagate).
"""

from __future__ import annotations

import httpx
import pytest

from services.projectors.chunk_embedder.main import (
    ChunkEmbedderProjector,
    Settings,
    _BadChunkError,
)


def _projector() -> ChunkEmbedderProjector:
    return ChunkEmbedderProjector(Settings(postgres_password="x"))


class _FakeResponse:
    def __init__(self, status_code: int, body: dict | None = None) -> None:
        self.status_code = status_code
        self._body = body or {}

    def json(self) -> dict:
        return self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("upstream", request=None, response=None)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_400_is_permanent(monkeypatch: pytest.MonkeyPatch) -> None:
    p = _projector()

    async def fake_post(*a, **k):  # noqa: ANN003
        return _FakeResponse(400)

    monkeypatch.setattr(p._client, "post", fake_post)
    with pytest.raises(_BadChunkError):
        await p._embed(["hi"])
    await p.aclose()


@pytest.mark.asyncio
async def test_500_is_transient(monkeypatch: pytest.MonkeyPatch) -> None:
    p = _projector()

    async def fake_post(*a, **k):  # noqa: ANN003
        return _FakeResponse(500)

    monkeypatch.setattr(p._client, "post", fake_post)
    with pytest.raises(httpx.HTTPStatusError):
        await p._embed(["hi"])
    await p.aclose()


@pytest.mark.asyncio
async def test_empty_vectors_is_permanent(monkeypatch: pytest.MonkeyPatch) -> None:
    p = _projector()

    async def fake_post(*a, **k):  # noqa: ANN003
        return _FakeResponse(200, {"vectors": []})

    monkeypatch.setattr(p._client, "post", fake_post)
    with pytest.raises(_BadChunkError):
        await p._embed(["hi"])
    await p.aclose()


@pytest.mark.asyncio
async def test_inconsistent_dims_is_permanent(monkeypatch: pytest.MonkeyPatch) -> None:
    p = _projector()

    async def fake_post(*a, **k):  # noqa: ANN003
        return _FakeResponse(200, {"vectors": [[0.1, 0.2], [0.3]], "dim": 2})

    monkeypatch.setattr(p._client, "post", fake_post)
    with pytest.raises(_BadChunkError):
        await p._embed(["a", "b"])
    await p.aclose()


@pytest.mark.asyncio
async def test_happy_path_returns_vectors(monkeypatch: pytest.MonkeyPatch) -> None:
    p = _projector()

    async def fake_post(*a, **k):  # noqa: ANN003
        return _FakeResponse(
            200, {"vectors": [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]], "dim": 3}
        )

    monkeypatch.setattr(p._client, "post", fake_post)
    out = await p._embed(["a", "b"])
    assert len(out) == 2
    assert len(out[0]) == 3
    await p.aclose()
