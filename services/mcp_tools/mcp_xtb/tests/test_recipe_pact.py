"""Cross-language pact: Python RECIPES and TypeScript XTB_RECIPES must agree.

Python source: ``services/mcp_tools/mcp_xtb/recipes/__init__.py`` exports
``RECIPES`` keyed by recipe name. TypeScript source:
``services/agent-claw/src/tools/builtins/run_xtb_workflow.ts`` exports
``XTB_RECIPES = [ ... ] as const``.

Drift between the two = a recipe added in Python but unreachable from
the agent (or worse, a TS-only entry that lands as a 400 unknown_recipe).
This test parses the TS file and asserts equality. Intentionally
fragile to formatting in run_xtb_workflow.ts: any restructure of
``XTB_RECIPES`` should update the test too.
"""

from __future__ import annotations

import re
from pathlib import Path

from services.mcp_tools.mcp_xtb.recipes import RECIPES

_TS_FILE = (
    Path(__file__).resolve().parents[3]
    / "agent-claw"
    / "src"
    / "tools"
    / "builtins"
    / "run_xtb_workflow.ts"
)


def _parse_ts_recipe_enum(text: str) -> list[str]:
    """Extract ``XTB_RECIPES = [ "foo", "bar" ] as const`` body."""
    match = re.search(
        r"XTB_RECIPES\s*=\s*\[([^\]]+)\]\s*as\s+const",
        text,
        re.DOTALL,
    )
    if not match:
        raise AssertionError(
            "XTB_RECIPES not found in run_xtb_workflow.ts or shape changed; "
            "update this test to match",
        )
    body = match.group(1)
    names: list[str] = []
    for line in body.splitlines():
        line = line.strip().rstrip(",")
        if not line or line.startswith("//"):
            continue
        kv_match = re.fullmatch(r'"([^"]+)"', line)
        if not kv_match:
            raise AssertionError(
                f"unrecognised XTB_RECIPES line: {line!r}; "
                "the TS array should be one `\"name\",` per line",
            )
        names.append(kv_match.group(1))
    return names


def test_python_and_ts_recipes_agree():
    ts_text = _TS_FILE.read_text(encoding="utf-8")
    ts_names = _parse_ts_recipe_enum(ts_text)

    py_keys = set(RECIPES.keys())
    ts_keys = set(ts_names)

    only_in_py = py_keys - ts_keys
    only_in_ts = ts_keys - py_keys
    assert not only_in_py, (
        f"recipes declared in Python but missing from TS: {sorted(only_in_py)}"
    )
    assert not only_in_ts, (
        f"recipes declared in TS but missing from Python: {sorted(only_in_ts)}"
    )


def test_ts_recipe_enum_has_no_duplicates():
    """A duplicate would silently pass z.enum() but signal a copy-paste bug."""
    ts_text = _TS_FILE.read_text(encoding="utf-8")
    ts_names = _parse_ts_recipe_enum(ts_text)
    assert len(ts_names) == len(set(ts_names)), (
        f"duplicate entries in XTB_RECIPES: {ts_names}"
    )


def test_recipe_names_are_lowercase_snake_case():
    """Convention check — keeps the name space consistent for log filtering."""
    for name in RECIPES:
        assert re.fullmatch(r"[a-z][a-z0-9_]*", name), (
            f"recipe name {name!r} should be lowercase_snake_case"
        )
