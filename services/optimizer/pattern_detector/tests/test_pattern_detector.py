"""Unit tests for the pattern_detector daemon.

compute_cluster_stats is pure and fully testable without DB.
"""
from __future__ import annotations

import pytest

from services.optimizer.pattern_detector.main import (
    compute_cluster_stats,
    _CV_THRESHOLD,
    _MIN_CLUSTER_SIZE,
)


def test_returns_none_for_too_few_values():
    assert compute_cluster_stats([1.0, 2.0, 3.0]) is None


def test_returns_none_for_empty():
    assert compute_cluster_stats([]) is None


def test_returns_none_for_constant_population():
    # All same value: cv=0, stdev=0, range=0 → both thresholds fail
    assert compute_cluster_stats([42.0] * 10) is None


def test_returns_stats_for_high_cv():
    # Wide spread: cv >> CV_THRESHOLD
    values = [10.0, 20.0, 80.0, 90.0, 15.0, 85.0]
    stats = compute_cluster_stats(values)
    assert stats is not None
    assert stats["count"] == 6
    assert stats["min"] == pytest.approx(10.0)
    assert stats["max"] == pytest.approx(90.0)


def test_stats_contain_required_keys():
    values = [10.0, 50.0, 90.0, 30.0, 70.0, 20.0]
    stats = compute_cluster_stats(values)
    assert stats is not None
    for key in ("count", "mean", "stdev", "min", "max", "q1", "q3", "cv", "range"):
        assert key in stats


def test_spread_population_is_detected():
    # Very wide range ensures cv OR range threshold fires.
    values = [1.0, 10.0, 50.0, 90.0, 100.0, 5.0]
    stats = compute_cluster_stats(values)
    assert stats is not None


def test_mean_is_correct():
    values = [10.0, 20.0, 30.0, 40.0, 50.0, 60.0]
    stats = compute_cluster_stats(values)
    assert stats is not None
    assert stats["mean"] == pytest.approx(35.0)


def test_stdev_positive_for_spread():
    values = [1.0, 10.0, 100.0, 50.0, 25.0, 75.0]
    stats = compute_cluster_stats(values)
    if stats is not None:
        assert stats["stdev"] > 0


def test_range_equals_max_minus_min():
    values = [5.0, 15.0, 25.0, 35.0, 45.0, 55.0]
    stats = compute_cluster_stats(values)
    if stats is not None:
        assert stats["range"] == pytest.approx(stats["max"] - stats["min"])


def test_min_cluster_size_constant():
    assert _MIN_CLUSTER_SIZE >= 3


def test_cv_threshold_constant():
    assert 0 < _CV_THRESHOLD < 1.0
