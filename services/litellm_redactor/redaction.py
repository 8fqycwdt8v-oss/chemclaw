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
from dataclasses import dataclass, field

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

    result = RedactionResult(text=text)

    def _sub(pattern: re.Pattern[str], kind: str, extra_check=None):
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
    _sub(_RXN_SMILES, "RXN_SMILES", extra_check=lambda v: v.count(">") >= 2)
    _sub(_SMILES_TOKEN, "SMILES", extra_check=_looks_like_smiles)
    _sub(_EMAIL, "EMAIL")
    _sub(_NCE_PROJECT, "NCE")
    _sub(_COMPOUND_CODE, "CMP")

    return result


def redact_messages(messages: list[dict]) -> list[dict]:
    """Apply redact() to every 'content' field in a list of chat messages.

    Does not mutate the input; returns a new list.
    """
    redacted = []
    for m in messages:
        if not isinstance(m, dict):
            redacted.append(m)
            continue
        copy = dict(m)
        content = m.get("content")
        if isinstance(content, str):
            copy["content"] = redact(content).text
        elif isinstance(content, list):
            # Anthropic-style list of content blocks.
            new_blocks = []
            for block in content:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    nb = dict(block)
                    nb["text"] = redact(block["text"]).text
                    new_blocks.append(nb)
                else:
                    new_blocks.append(block)
            copy["content"] = new_blocks
        redacted.append(copy)
    return redacted
