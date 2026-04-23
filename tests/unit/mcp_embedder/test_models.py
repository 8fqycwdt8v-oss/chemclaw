"""Unit tests for mcp_embedder input validation."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from services.mcp_tools.mcp_embedder.models import EmbedTextRequest


def test_accepts_reasonable_input() -> None:
    req = EmbedTextRequest(inputs=["hello world", "another text"])
    assert req.inputs == ["hello world", "another text"]
    assert req.normalize is True


def test_empty_inputs_list_rejected() -> None:
    with pytest.raises(ValidationError):
        EmbedTextRequest(inputs=[])


def test_empty_string_input_rejected() -> None:
    with pytest.raises(ValidationError):
        EmbedTextRequest(inputs=[""])


def test_oversized_single_input_rejected() -> None:
    with pytest.raises(ValidationError):
        EmbedTextRequest(inputs=["a" * 40_001])


def test_oversized_batch_rejected() -> None:
    with pytest.raises(ValidationError):
        EmbedTextRequest(inputs=["x"] * 129)
