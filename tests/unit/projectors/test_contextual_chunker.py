"""Unit tests for the contextual_chunker projector — Phase C.2.

Uses a stub LLM client to avoid real HTTP calls.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.projectors.contextual_chunker.main import (
    ContextualChunkerProjector,
    Settings,
    _PermanentChunkError,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_settings() -> Settings:
    return Settings(
        postgres_host="localhost",
        postgres_port=5432,
        postgres_db="chemclaw",
        postgres_user="chemclaw",
        postgres_password="test",
        litellm_base_url="http://localhost:4000",
        litellm_api_key="sk-test",
        context_model="claude-haiku-4-5",
    )


def make_projector() -> ContextualChunkerProjector:
    settings = make_settings()
    return ContextualChunkerProjector(settings)


# ---------------------------------------------------------------------------
# _generate_prefix unit tests with stub HTTP client
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_generate_prefix_returns_llm_content() -> None:
    """generate_prefix returns the content from the LLM response."""
    projector = make_projector()

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [
            {"message": {"content": "This chunk describes the amide coupling reaction."}}
        ]
    }
    mock_response.raise_for_status = MagicMock()

    projector._client = AsyncMock()
    projector._client.post = AsyncMock(return_value=mock_response)

    result = await projector._generate_prefix(
        doc_title="Synthetic Procedure SOP-042",
        prev_snippet="The reaction was heated to 80°C.",
        chunk_text="DMF (10 mL) was added dropwise...",
    )

    assert result == "This chunk describes the amide coupling reaction."


@pytest.mark.asyncio
async def test_generate_prefix_raises_permanent_on_4xx() -> None:
    """generate_prefix raises _PermanentChunkError on 4xx HTTP status."""
    projector = make_projector()

    mock_response = MagicMock()
    mock_response.status_code = 400
    mock_response.text = "Bad request"
    projector._client = AsyncMock()
    projector._client.post = AsyncMock(return_value=mock_response)

    with pytest.raises(_PermanentChunkError, match="LiteLLM 4xx"):
        await projector._generate_prefix(
            doc_title="Test Doc",
            prev_snippet="",
            chunk_text="Some chunk text.",
        )


@pytest.mark.asyncio
async def test_generate_prefix_sends_doc_title_in_request() -> None:
    """generate_prefix includes document title in the LLM request."""
    projector = make_projector()

    captured_json: list[dict] = []

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"content": "Context sentence."}}]
    }
    mock_response.raise_for_status = MagicMock()

    async def capture_post(url: str, *, headers: Any, json: Any) -> Any:
        captured_json.append(json)
        return mock_response

    projector._client = AsyncMock()
    projector._client.post = AsyncMock(side_effect=capture_post)

    await projector._generate_prefix(
        doc_title="Unique Document Title 9876",
        prev_snippet="",
        chunk_text="Some chunk content.",
    )

    assert captured_json, "No POST was made"
    user_content = captured_json[0]["messages"][1]["content"]
    assert "Unique Document Title 9876" in user_content


@pytest.mark.asyncio
async def test_generate_prefix_handles_empty_llm_content() -> None:
    """generate_prefix returns empty string when LLM returns empty content."""
    projector = make_projector()

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "choices": [{"message": {"content": "   "}}]
    }
    mock_response.raise_for_status = MagicMock()
    projector._client = AsyncMock()
    projector._client.post = AsyncMock(return_value=mock_response)

    result = await projector._generate_prefix(
        doc_title="Doc",
        prev_snippet="",
        chunk_text="Chunk.",
    )
    # Empty / whitespace-only content returns empty string after strip.
    assert result == ""
