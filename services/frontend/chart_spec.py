"""Validated chart specification model for the Streamlit frontend.

The agent may embed fenced ``chart`` blocks in its responses.  This module
parses and strictly validates those blocks so the UI can render them with
``st.bar_chart`` / ``st.line_chart`` / ``st.scatter_chart`` without trusting
raw LLM output.

Bounds
------
- ``type``:    must be one of ``bar``, ``line``, ``scatter``
- ``x``:       1–1000 labels (strings)
- ``y``:       1–1000 numeric values (matches ``x`` length)
- ``series``:  at most 10 additional named series
- Each series ``values``: 1–1000 numeric values
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)

_MAX_POINTS = 1000
_MAX_SERIES = 10


class Series(BaseModel):
    """A single named data series for multi-series charts."""

    name: Annotated[str, Field(min_length=1, max_length=200)]
    values: Annotated[
        list[float],
        Field(min_length=1, max_length=_MAX_POINTS),
    ]


class ChartSpec(BaseModel):
    """Validated chart specification emitted by the agent."""

    type: Literal["bar", "line", "scatter"]
    x: Annotated[
        list[str],
        Field(min_length=1, max_length=_MAX_POINTS),
    ]
    y: Annotated[
        list[float],
        Field(min_length=1, max_length=_MAX_POINTS),
    ]
    title: Annotated[str, Field(default="", max_length=200)]
    x_label: Annotated[str, Field(default="", max_length=200)]
    y_label: Annotated[str, Field(default="", max_length=200)]
    series: Annotated[
        list[Series],
        Field(default_factory=list, max_length=_MAX_SERIES),
    ]

    @model_validator(mode="after")
    def _lengths_match(self) -> "ChartSpec":
        if len(self.x) != len(self.y):
            raise ValueError(
                f"x length ({len(self.x)}) must equal y length ({len(self.y)})"
            )
        for s in self.series:
            if len(s.values) != len(self.x):
                raise ValueError(
                    f"series '{s.name}' length ({len(s.values)}) must equal "
                    f"x length ({len(self.x)})"
                )
        return self


def parse_chart_spec(raw_json: str) -> ChartSpec | None:
    """Parse and validate a JSON string as a ``ChartSpec``.

    Returns ``None`` (and logs a warning) on any parse or validation error so
    callers can fall back to plain code rendering.
    """
    try:
        data = json.loads(raw_json)
    except json.JSONDecodeError as exc:
        logger.warning("chart_spec: malformed JSON — %s", exc)
        return None

    try:
        return ChartSpec.model_validate(data)
    except Exception as exc:  # noqa: BLE001
        logger.warning("chart_spec: validation failed — %s", exc)
        return None
