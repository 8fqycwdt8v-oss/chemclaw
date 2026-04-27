"""Cross-language pact: Python and TypeScript SERVICE_SCOPES must agree.

Cycle 3 added `services/mcp_tools/common/scopes.py` and
`services/agent-claw/src/security/mcp-token-cache.ts`. The agent reads the
TS map to mint tokens; each MCP service reads the Python map to declare
the scope its middleware enforces. Drift between the two = silent 403 in
production that dev mode hides.

This test parses the TS file and asserts string-by-string equality. It is
intentionally fragile to formatting in mcp-token-cache.ts: any restructure
of `SERVICE_SCOPES` should update the test too. The fragility is the
point — a green test is the only signal that the two maps are in sync.
"""

from __future__ import annotations

import re
from pathlib import Path

from services.mcp_tools.common.scopes import SERVICE_SCOPES

_TS_FILE = Path(__file__).resolve().parents[3] / "agent-claw" / "src" / "security" / "mcp-token-cache.ts"


def _parse_ts_service_scopes(text: str) -> dict[str, str]:
    """Extract `SERVICE_SCOPES: Record<string, string> = { ... };` body.

    Tolerates leading/trailing whitespace and trailing commas; rejects
    multi-line values, list values, or anything else suggesting the TS
    map has drifted to a richer shape than the Python one.
    """
    match = re.search(
        r"SERVICE_SCOPES:\s*Record<string,\s*string>\s*=\s*\{([^}]+)\}",
        text,
        re.DOTALL,
    )
    if not match:
        raise AssertionError(
            "SERVICE_SCOPES not found in mcp-token-cache.ts or shape changed; "
            "update test_scope_pact.py to match"
        )
    body = match.group(1)
    pairs: dict[str, str] = {}
    for line in body.splitlines():
        line = line.strip().rstrip(",")
        if not line or line.startswith("//"):
            continue
        kv_match = re.fullmatch(r'"([^"]+)"\s*:\s*"([^"]+)"', line)
        if not kv_match:
            raise AssertionError(
                f"unrecognised SERVICE_SCOPES line: {line!r}; "
                "the TS map should be one `\"name\": \"scope\",` per line"
            )
        pairs[kv_match.group(1)] = kv_match.group(2)
    return pairs


def test_python_and_ts_service_scopes_agree():
    ts_text = _TS_FILE.read_text(encoding="utf-8")
    ts_scopes = _parse_ts_service_scopes(ts_text)

    py_keys = set(SERVICE_SCOPES.keys())
    ts_keys = set(ts_scopes.keys())

    only_in_py = py_keys - ts_keys
    only_in_ts = ts_keys - py_keys
    assert not only_in_py, (
        f"services declared in Python but missing from TS: {sorted(only_in_py)}"
    )
    assert not only_in_ts, (
        f"services declared in TS but missing from Python: {sorted(only_in_ts)}"
    )

    mismatches = {
        k: (SERVICE_SCOPES[k], ts_scopes[k])
        for k in py_keys
        if SERVICE_SCOPES[k] != ts_scopes[k]
    }
    assert not mismatches, (
        f"scope strings differ between Python and TS: {mismatches}"
    )


def test_no_service_has_empty_scope():
    """Catch typos like `"mcp-rdkit": "",` that would silently allow any token."""
    for service, scope in SERVICE_SCOPES.items():
        assert scope, f"empty scope for service {service!r}"
        assert ":" in scope, (
            f"scope {scope!r} for service {service!r} doesn't follow "
            "`<resource>:<action>` convention"
        )
