"""Redaction rules for outbound LLM prompts.

The redactor replaces sensitive substrings with type-tagged placeholders. It
is conservative by design — over-redaction is better than leakage. False
positives can be tuned by adjusting patterns.

Pattern families:
- SMILES strings in bare text (heuristic regex; safe-regex validated)
- Internal compound codes matching configurable prefixes (e.g., CMP-\\d{6})
- Email addresses (Entra IDs, operators' emails)
- Internal project identifiers (NCE-\\d{3}, NCE-\\d+)

Each placeholder includes a stable, per-value suffix so the redactor is
deterministic — the same SMILES always maps to the same placeholder within
a single call, enabling the model to reason referentially without seeing
structures.

For production, extend with a dedicated NER model (spaCy/PII model) behind
these regex rules. For the MVP redactor, regex + explicit allowlists cover
the documented threat surface.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

# Defense against pathological input: real prompts are <100KB. Anything past
# this is refused (returned unmodified) to bound the worst-case CPU spent in
# the regex engine. Even bounded quantifiers do O(n*k) work; with n in the
# megabytes that gets expensive enough to be a soft DoS vector.
_MAX_REDACTION_INPUT_LEN = 5 * 1024 * 1024

# SMILES heuristic: any token containing at least 5 bond/atom characters and
# at least one ring-closure or bond symbol. Tightened with word boundaries to
# avoid eating prose. Avoids catastrophic backtracking (each class is bounded).
_SMILES_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])"                           # left boundary
    r"(?:"
    r"[A-Za-z0-9@+\-\[\]\(\)=#/\\\.]{6,200}"      # char class, bounded length
    r")"
    r"(?![A-Za-z0-9])"                            # right boundary
)

# Reaction SMILES: two '>' separators. Bounded lengths prevent a single
# token from sweeping up unbounded text.
# Always pre-gated on a cheap O(n) >=2 '>' count before .sub() is called so
# that prose without any reaction arrows skips the regex engine entirely.
_RXN_SMILES = re.compile(r"\S{1,400}>\S{0,400}>\S{1,400}")

# Email: each component length-capped to avoid pathological inputs.
_EMAIL = re.compile(
    r"[a-zA-Z0-9_.+\-]{1,64}@[a-zA-Z0-9\-]{1,253}\.[a-zA-Z0-9\-.]{2,63}"
)

# NCE project identifier (configurable prefix pattern).
_NCE_PROJECT = re.compile(r"\bNCE-\d{1,6}\b", re.IGNORECASE)

# Internal compound code (configurable; default CMP-\d{4,8}).
_COMPOUND_CODE = re.compile(r"\bCMP-\d{4,8}\b", re.IGNORECASE)


def _tag(kind: str, value: str) -> str:
    """Deterministic short tag: <{KIND}_{first 8 chars of sha1(value)}>."""
    h = hashlib.sha1(value.encode("utf-8")).hexdigest()[:8]
    return f"<{kind}_{h}>"


def _looks_like_smiles(token: str) -> bool:
    """Heuristic: must contain typical SMILES grammar characters."""
    has_bond = any(c in token for c in "=#()/\\")
    has_letter = any(c.isalpha() for c in token)
    return has_bond and has_letter and len(token) >= 6


@dataclass
class RedactionResult:
    text: str
    replacements: dict[str, str] = field(default_factory=dict)
    #: Counts by category for metrics.
    counts: dict[str, int] = field(default_factory=dict)

    def bump(self, kind: str) -> None:
        self.counts[kind] = self.counts.get(kind, 0) + 1


def redact(text: str) -> RedactionResult:
    """Return the redacted text plus a map of placeholder → original value.

    The mapping is kept in-memory per-call only; we do NOT persist it (the
    agent should cope with stable placeholders and re-materialize values from
    the KG when needed).
    """
    if not text:
        return RedactionResult(text=text)

    # Bound the worst-case CPU cost. A 5 MB prompt is already 50× larger than
    # any real chat message; refuse outright rather than burn seconds on it.
    if len(text) > _MAX_REDACTION_INPUT_LEN:
        return RedactionResult(text=text)

    result = RedactionResult(text=text)

    def _sub(
        pattern: re.Pattern[str],
        kind: str,
        extra_check: Callable[[str], bool] | None = None,
    ) -> None:
        def replace(match: re.Match[str]) -> str:
            value = match.group(0)
            if extra_check is not None and not extra_check(value):
                return value
            tag = _tag(kind, value)
            result.replacements.setdefault(tag, value)
            result.bump(kind)
            return tag

        result.text = pattern.sub(replace, result.text)

    # Order matters: run reaction SMILES before generic SMILES token.
    # Pre-gate on a cheap O(n) >=2 arrow count: text without two '>' chars
    # cannot match RXN_SMILES, so we skip the bounded-quantifier scan that
    # otherwise costs O(n*400) per call.
    if text.count(">") >= 2:
        _sub(_RXN_SMILES, "RXN_SMILES", extra_check=lambda v: v.count(">") >= 2)
    _sub(_SMILES_TOKEN, "SMILES", extra_check=_looks_like_smiles)
    _sub(_EMAIL, "EMAIL")
    _sub(_NCE_PROJECT, "NCE")
    _sub(_COMPOUND_CODE, "CMP")

    return result


def redact_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply redact() to every 'content' field in a list of chat messages.

    Also scrubs OpenAI-style assistant tool_calls (each tool_call's
    function.arguments JSON string) so SMILES / NCE-IDs / compound-codes
    that the model emits as tool arguments don't leak back to the next
    LLM call. Tool-result messages (role="tool") are scrubbed via the
    content path above.

    Does not mutate the input; returns a new list.
    """
    redacted, _counts = redact_messages_with_counts(messages)
    return redacted


def redact_messages_with_counts(
    messages: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Same shape as redact_messages, but also returns aggregated
    redaction counts (`{kind: total_count}`) summed across every
    string redacted in the message list.

    This avoids the double-redact pattern where a counts-aggregator
    would re-run `redact()` over every message just to read `.counts`
    — for a 200-row OFAT-campaign assistant turn that's a measurable
    hot-path cost. Callers that need both (litellm_redactor.callback)
    use this; callers that only need the wire payload keep using the
    old `redact_messages` shim above.
    """
    redacted: list[dict[str, Any]] = []
    totals: dict[str, int] = {}

    def _bump(kind_counts: dict[str, int]) -> None:
        for kind, n in kind_counts.items():
            totals[kind] = totals.get(kind, 0) + n

    for m in messages:
        if not isinstance(m, dict):
            redacted.append(m)
            continue
        copy = dict(m)
        content = m.get("content")
        if isinstance(content, str):
            r = redact(content)
            _bump(r.counts)
            copy["content"] = r.text
        elif isinstance(content, list):
            # Anthropic-style list of content blocks.
            new_blocks = []
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    nb = dict(block)
                    r = redact(block["text"])
                    _bump(r.counts)
                    nb["text"] = r.text
                    new_blocks.append(nb)
                else:
                    new_blocks.append(block)
            copy["content"] = new_blocks

        # OpenAI-style tool_calls — assistant messages with no content but
        # function.arguments holding the LLM's tool input. Each arguments
        # value is a JSON-encoded string; redact the whole string and
        # preserve the tool_calls structure.
        tool_calls = m.get("tool_calls")
        if isinstance(tool_calls, list):
            new_tcs = []
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    new_tcs.append(tc)
                    continue
                new_tc = dict(tc)
                fn = tc.get("function")
                if isinstance(fn, dict):
                    new_fn = dict(fn)
                    args = fn.get("arguments")
                    if isinstance(args, str) and args:
                        # Redact the JSON string verbatim — patterns are
                        # length-bounded so this is safe on any size payload.
                        r = redact(args)
                        _bump(r.counts)
                        new_fn["arguments"] = r.text
                    new_tc["function"] = new_fn
                new_tcs.append(new_tc)
            copy["tool_calls"] = new_tcs

        redacted.append(copy)
    return redacted, totals
