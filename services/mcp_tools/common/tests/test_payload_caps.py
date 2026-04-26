"""Tests for the JSONB pass-through size cap."""

from __future__ import annotations

from services.mcp_tools.common.payload_caps import (
    DEFAULT_JSONB_CAP_BYTES,
    cap_jsonb,
)


def test_small_dict_passes_through_unchanged() -> None:
    payload = {"yield_pct": 87.5, "solvent": "toluene", "temp_c": 80}
    assert cap_jsonb(payload) == payload


def test_small_list_passes_through_unchanged() -> None:
    payload = [{"rt": 1.2, "area": 1000}, {"rt": 3.4, "area": 500}]
    assert cap_jsonb(payload) == payload


def test_none_passes_through_unchanged() -> None:
    assert cap_jsonb(None) is None


def test_oversized_dict_returns_truncation_marker() -> None:
    big_payload = {"x": "x" * (DEFAULT_JSONB_CAP_BYTES + 100)}
    out = cap_jsonb(big_payload, field_name="parameters_jsonb")
    assert out["_truncated"] is True
    assert out["_field"] == "parameters_jsonb"
    assert out["_limit_bytes"] == DEFAULT_JSONB_CAP_BYTES
    assert out["_original_size_bytes"] > DEFAULT_JSONB_CAP_BYTES
    assert isinstance(out["_preview"], str)
    assert len(out["_preview"]) <= 500


def test_custom_cap_respected() -> None:
    payload = {"a": 1, "b": 2, "c": 3}
    # Cap so small that even the small payload trips it.
    out = cap_jsonb(payload, cap_bytes=5, field_name="tiny")
    assert out["_truncated"] is True
    assert out["_limit_bytes"] == 5
    assert out["_field"] == "tiny"


def test_unencodable_value_returns_marker_not_500() -> None:
    # Sets aren't JSON-serializable by default, but cap_jsonb uses
    # default=str so they fall back to a string repr; ergo this still
    # encodes successfully. Use a circular ref to trigger the failure
    # path instead.
    a: list = []
    a.append(a)
    out = cap_jsonb(a, field_name="circular")
    assert out["_truncated"] is True
    assert out["_field"] == "circular"
    assert out["_original_size_bytes"] == -1
    assert "unencodable" in out["_preview"]


def test_oversized_list_of_peaks_returns_marker() -> None:
    """Realistic shape: an MS run with thousands of peaks."""
    big_peak_list = [
        {"rt": float(i) / 100, "area": i, "name": f"peak_{i:05d}"}
        for i in range(20_000)
    ]
    out = cap_jsonb(big_peak_list, field_name="peaks_jsonb")
    assert out["_truncated"] is True
    assert out["_field"] == "peaks_jsonb"
    assert out["_original_size_bytes"] > DEFAULT_JSONB_CAP_BYTES
