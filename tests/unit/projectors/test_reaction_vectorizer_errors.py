"""Unit tests for the reaction_vectorizer projector's error policy.

Critical contract: 4xx responses from mcp-drfp are **permanent** failures
(skip that reaction, still ack the event); 5xx and network errors are
**transient** (propagate so base class doesn't ack, retry on next NOTIFY).
"""

from __future__ import annotations

import httpx
import pytest

from services.projectors.reaction_vectorizer.main import (
    ReactionVectorizerProjector,
    Settings,
    _BadSmilesError,
)


def _projector() -> ReactionVectorizerProjector:
    s = Settings(postgres_password="x")
    return ReactionVectorizerProjector(s)


class _FakeResponse:
    def __init__(self, status_code: int, body: dict | None = None) -> None:
        self.status_code = status_code
        self._body = body or {}

    def json(self) -> dict:
        return self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise httpx.HTTPStatusError(
                "upstream error", request=None, response=None  # type: ignore[arg-type]
            )


@pytest.mark.asyncio
async def test_400_raises_bad_smiles_error(monkeypatch: pytest.MonkeyPatch) -> None:
    p = _projector()

    async def fake_post(*args, **kwargs):  # noqa: ANN003
        return _FakeResponse(400, {})

    monkeypatch.setattr(p._client, "post", fake_post)

    with pytest.raises(_BadSmilesError):
        await p._compute("garbage>>garbage")

    await p.aclose()


@pytest.mark.asyncio
async def test_500_propagates_as_transient(monkeypatch: pytest.MonkeyPatch) -> None:
    p = _projector()

    async def fake_post(*args, **kwargs):  # noqa: ANN003
        return _FakeResponse(500, {})

    monkeypatch.setattr(p._client, "post", fake_post)

    # 5xx must NOT be swallowed into _BadSmilesError — it must propagate so
    # the base projector refuses to ack the event.
    with pytest.raises(httpx.HTTPStatusError):
        await p._compute("C>>CC")

    await p.aclose()


@pytest.mark.asyncio
async def test_network_error_propagates_as_transient(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    p = _projector()

    async def fake_post(*args, **kwargs):  # noqa: ANN003
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(p._client, "post", fake_post)

    with pytest.raises(httpx.HTTPError):
        await p._compute("C>>CC")

    await p.aclose()


@pytest.mark.asyncio
async def test_short_vector_is_permanent_error(monkeypatch: pytest.MonkeyPatch) -> None:
    p = _projector()

    async def fake_post(*args, **kwargs):  # noqa: ANN003
        return _FakeResponse(200, {"vector": [0, 1, 0]})

    monkeypatch.setattr(p._client, "post", fake_post)

    with pytest.raises(_BadSmilesError):
        await p._compute("C>>CC")

    await p.aclose()
