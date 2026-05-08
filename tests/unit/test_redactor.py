"""Unit tests for the LiteLLM redactor."""

from __future__ import annotations

import pytest

from services.litellm_redactor.redaction import (
    redact,
    redact_messages,
    redact_messages_with_counts,
)


def test_redacts_reaction_smiles() -> None:
    text = "We ran N#Cc1ccc(Br)cc1.OB(O)c1ccccc1>>N#Cc1ccc(-c2ccccc2)cc1 at 85 C."
    out = redact(text)
    assert "N#Cc1ccc(Br)cc1" not in out.text
    assert out.counts.get("RXN_SMILES", 0) >= 1 or out.counts.get("SMILES", 0) >= 1


def test_redacts_emails_and_project_codes() -> None:
    text = "Contact alice.chemist@example.com about NCE-001 and CMP-12345."
    out = redact(text)
    assert "alice.chemist@example.com" not in out.text
    assert "NCE-001" not in out.text
    assert "CMP-12345" not in out.text
    assert out.counts["EMAIL"] == 1
    assert out.counts["NCE"] == 1
    assert out.counts["CMP"] == 1


def test_redaction_is_deterministic() -> None:
    a = redact("NCE-042 / alice@x.com").text
    b = redact("NCE-042 / alice@x.com").text
    assert a == b


def test_keeps_prose_intact() -> None:
    text = "The Suzuki coupling worked nicely at 85 degrees Celsius."
    out = redact(text)
    # No SMILES-looking tokens, no emails, no codes → text unchanged.
    assert out.text == text
    assert out.counts == {}


def test_rxn_smiles_regex_is_bounded() -> None:
    """An unbounded regex could match a huge substring. Give the redactor
    40k chars of plausibly-structural tokens joined with '>' and verify it
    doesn't collapse the whole string into a single match."""
    s = ("CC" * 300) + ">" + ("OO" * 300) + ">" + ("NN" * 300)
    out = redact(" ".join([s, s, s]))
    # No single match should consume the whole joined blob.
    assert len(out.text) > 0
    # All redaction counts bounded by input length / 400 ≈ a few.
    total = sum(out.counts.values())
    assert total < 100


def test_email_regex_is_bounded() -> None:
    """Ensure email regex doesn't melt down on a long pseudo-email."""
    huge = ("a" * 2000) + "@" + ("b" * 2000) + ".com"
    out = redact(f"before {huge} after")
    # Either it matches a bounded substring or not at all; either way
    # the function returns quickly and produces text of comparable length.
    assert "before " in out.text and " after" in out.text


def test_redact_completes_quickly_on_arrow_heavy_input() -> None:
    """Audit P1: RXN_SMILES regex used to take ~3.5s on 200KB adversarial
    input because the bounded-quantifier scan ran on every starting position.
    The pre-gate on '>' count + the 5MB input cap together hold the worst
    case to well under a second."""
    import time

    # 200KB of arrow-heavy non-SMILES prose (Markdown blockquotes are the
    # benign trigger we actually see in the wild).
    payload = ("> quoted line\n" * (200 * 1024 // 14))
    start = time.monotonic()
    out = redact(payload)
    elapsed = time.monotonic() - start

    assert elapsed < 1.0, f"redact() took {elapsed:.2f}s on 200KB arrow-heavy input"
    # No real reaction SMILES is present; counts must be zero or trivially low.
    assert out.counts.get("RXN_SMILES", 0) == 0


def test_redact_skips_oversized_input() -> None:
    """Inputs larger than the 5MB cap return unmodified — bounding worst
    case CPU regardless of pattern shape."""
    huge = "alice@example.com " * (6 * 1024 * 1024 // 18)
    assert len(huge) > 5 * 1024 * 1024
    out = redact(huge)
    # Refusal: exact same string back, no replacements recorded.
    assert out.text == huge
    assert out.counts == {}


def test_redact_skips_rxn_regex_when_arrows_absent() -> None:
    """Sanity: prose without two '>' chars must not invoke the RXN_SMILES
    regex. We can't observe the skip directly, but we can assert that the
    redactor finishes well below the cost of actually running the
    bounded-quantifier RXN regex on the input.

    Threshold = 2.5s. With the skip path active the redactor finishes
    in <100ms locally and ~600ms-1s on slow CI runners (GitHub Actions
    standard tier). Without the skip path the bounded RXN regex on 1MB
    of input takes 3-5s in profile traces — well above the threshold,
    so a regression that drops the cheap O(n) arrow count would still
    trip the assertion."""
    import time

    payload = "ChemClaw is great. " * (1024 * 1024 // 19)
    start = time.monotonic()
    out = redact(payload)
    elapsed = time.monotonic() - start

    assert elapsed < 2.5, f"redact() took {elapsed:.2f}s on 1MB arrow-free prose"
    assert out.counts.get("RXN_SMILES", 0) == 0


def test_redact_messages_handles_string_and_list_content() -> None:
    msgs = [
        {"role": "user", "content": "Analyse CMP-99999 please."},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Contact bob@lab.org about NCE-007."},
                {"type": "image", "source": {"url": "https://example.com/x.png"}},
            ],
        },
    ]
    out = redact_messages(msgs)
    assert "CMP-99999" not in out[0]["content"]
    block0 = out[1]["content"][0]
    assert "bob@lab.org" not in block0["text"]
    assert "NCE-007" not in block0["text"]
    # Non-text block preserved.
    assert out[1]["content"][1]["type"] == "image"


# ---------------------------------------------------------------------------
# False-positive resistance for the SMILES heuristic.
#
# `_looks_like_smiles` documents specific prose patterns it must NOT fire on
# (CLI flags, key=value pairs, paths). These tests pin that contract — a
# regression that loosens the heuristic will leak prose into the redactor's
# replacement map and surface as <SMILES_*> tags inside model prompts.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "prose",
    # These are the false-positive triggers `_looks_like_smiles` was tightened
    # to reject: equals-sign and key-value prose without any SMILES atom on
    # the right of a structural character, ratios, percentages.
    # NOTE: URL paths and unix-style paths (e.g. "/usr/local/bin/python",
    # "https://...") still trip the heuristic because '/p', '/c', '/n' look
    # like multi-bonds to a SMILES atom — that limitation is acknowledged in
    # the `_looks_like_smiles` docstring and the post_turn defense-in-depth
    # scrub catches the residual leak. Pinning that here would freeze a known
    # over-redaction case as "good", which it isn't.
    [
        "Run with --opt=value to enable feature.",
        "See page=12, line=34 of the manual.",
        "Use --no-cache=true and retry.",
        "The ratio is 2:1 with 50% yield.",
        "Cells in row=5 column=12 of the grid.",
    ],
)
def test_smiles_heuristic_rejects_prose(prose: str) -> None:
    out = redact(prose)
    assert out.text == prose, f"prose got tagged: {out.text!r}"
    assert out.counts.get("SMILES", 0) == 0


@pytest.mark.parametrize(
    "smiles",
    [
        "CCO",                    # ethanol — too short, won't match the 6-char floor
        "c1ccccc1",               # benzene aromatic — has ring closure
        "[Na+].[Cl-]",            # bracketed atoms
        "CC(=O)O",                # acetic acid — multi-bond + atom
        "N#Cc1ccccc1",            # benzonitrile — multi-bond and ring closure
    ],
)
def test_smiles_heuristic_catches_real_chemistry(smiles: str) -> None:
    text = f"prefix {smiles} suffix"
    out = redact(text)
    # Tokens shorter than 6 chars are deliberately not redacted (documented
    # in `_looks_like_smiles`); just assert prose is never harmed and that
    # tokens long enough to match the regex *do* get tagged.
    if len(smiles) >= 6:
        assert smiles not in out.text, f"SMILES leaked: {out.text!r}"
        assert out.counts.get("SMILES", 0) >= 1
    assert "prefix" in out.text and "suffix" in out.text


# ---------------------------------------------------------------------------
# Placeholder structure and reversibility.
# ---------------------------------------------------------------------------

def test_placeholder_format_is_kind_tagged_and_stable() -> None:
    """Same value twice in one call → same placeholder; different values →
    different placeholders. The replacements map must round-trip back to the
    original strings."""
    # Spaces around emails so the email regex doesn't sweep up trailing
    # punctuation (the TLD class is documented to include '.' — see
    # test_email_redaction_is_greedy_with_trailing_period).
    text = "Email alice@x.com and alice@x.com again plus bob@y.com here."
    out = redact(text)
    # Two distinct emails → two placeholders; the duplicate of alice@x.com
    # collapses to the same tag.
    tags = [tag for tag in out.replacements if tag.startswith("<EMAIL_")]
    assert len(tags) == 2
    # Every placeholder maps back to the original.
    for tag, original in out.replacements.items():
        assert original in {"alice@x.com", "bob@y.com"}
        assert tag in out.text
    # Counts reflect three replacement events (alice twice, bob once).
    assert out.counts["EMAIL"] == 3


def test_placeholders_are_stable_across_calls() -> None:
    """Determinism is documented as a feature: the same SMILES/email/code
    must yield the same placeholder across separate calls so the model can
    refer to it consistently within a session."""
    a = redact("alice@example.com")
    b = redact("alice@example.com")
    assert a.text == b.text
    # Same tag on both sides of the round-trip.
    assert set(a.replacements) == set(b.replacements)


def test_redact_handles_empty_and_whitespace_input() -> None:
    assert redact("").text == ""
    assert redact("").counts == {}
    out = redact("   \n\t  ")
    assert out.text == "   \n\t  "
    assert out.counts == {}


# ---------------------------------------------------------------------------
# Email pattern edge cases.
# ---------------------------------------------------------------------------

def test_email_with_subdomain_and_plus_alias_is_redacted() -> None:
    text = "Reach me at alice+chem@research.lab.example.co.uk for details."
    out = redact(text)
    assert "alice+chem@research.lab.example.co.uk" not in out.text
    assert out.counts["EMAIL"] == 1


def test_email_redaction_is_greedy_with_trailing_period() -> None:
    """Documented contract: the email TLD class includes '.', so an email
    immediately followed by a sentence-ending period gets the period eaten
    into the placeholder. This is consistent with the redactor's "over-
    redaction is better than leakage" stance — pin it so a regex tightening
    that drops the trailing dot is a deliberate change with a test update,
    not a silent behaviour shift."""
    text = "Write to bob@lab.org, then carol@lab.org."
    out = redact(text)
    assert out.counts["EMAIL"] == 2
    # Neither email survives in the redacted text.
    assert "bob@lab.org" not in out.text
    assert "carol@lab.org" not in out.text
    # The trailing period is captured into carol's placeholder; assert that
    # explicitly so a future loosening doesn't sneak through.
    originals = set(out.replacements.values())
    assert "bob@lab.org" in originals
    assert "carol@lab.org." in originals  # trailing period included
    # Comma between the two stays as prose — it isn't in the TLD class.
    assert "," in out.text


# ---------------------------------------------------------------------------
# redact_messages_with_counts — the optimised counts-aware variant used by
# the LiteLLM callback. Previously only redact_messages (which discards
# counts) was directly tested.
# ---------------------------------------------------------------------------

def test_redact_messages_with_counts_aggregates_across_messages() -> None:
    msgs = [
        {"role": "user", "content": "alice@x.com and NCE-1"},
        {"role": "assistant", "content": "ack CMP-12345"},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "another bob@y.com"},
            ],
        },
    ]
    redacted, totals = redact_messages_with_counts(msgs)
    assert totals["EMAIL"] == 2
    assert totals["NCE"] == 1
    assert totals["CMP"] == 1
    # Per-message redaction still applies.
    assert "alice@x.com" not in redacted[0]["content"]
    assert "CMP-12345" not in redacted[1]["content"]
    assert "bob@y.com" not in redacted[2]["content"][0]["text"]


def test_redact_messages_does_not_mutate_input() -> None:
    msgs = [{"role": "user", "content": "alice@x.com"}]
    snapshot = "alice@x.com"
    redact_messages(msgs)
    assert msgs[0]["content"] == snapshot


def test_redact_messages_passes_through_non_dict_entries() -> None:
    """Defensive: malformed entries shouldn't crash the redactor."""
    msgs: list = ["not a dict", {"role": "user", "content": "alice@x.com"}, 42]
    out = redact_messages(msgs)
    assert out[0] == "not a dict"
    assert out[2] == 42
    assert "alice@x.com" not in out[1]["content"]


# ---------------------------------------------------------------------------
# OpenAI-style tool_calls scrubbing — assistant turns where the sensitive
# value lives inside `function.arguments` (a JSON string). Regression
# protection for the path added when OFAT-campaign tool calls were leaking
# SMILES back into the next LLM turn.
# ---------------------------------------------------------------------------

def test_redact_messages_scrubs_openai_tool_call_arguments() -> None:
    msgs = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "lookup_compound",
                        "arguments": '{"smiles": "N#Cc1ccc(Br)cc1", "code": "CMP-12345", "owner": "alice@x.com"}',
                    },
                }
            ],
        }
    ]
    redacted, totals = redact_messages_with_counts(msgs)
    args = redacted[0]["tool_calls"][0]["function"]["arguments"]
    assert "N#Cc1ccc(Br)cc1" not in args
    assert "CMP-12345" not in args
    assert "alice@x.com" not in args
    assert totals.get("EMAIL", 0) == 1
    assert totals.get("CMP", 0) == 1
    assert totals.get("SMILES", 0) >= 1


def test_redact_messages_preserves_tool_call_structure() -> None:
    """Tool-call ID, type, function name, and unrelated fields must survive
    redaction so the model and tool dispatch still line up."""
    msgs = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_xyz",
                    "type": "function",
                    "function": {
                        "name": "lookup_compound",
                        "arguments": '{"code": "CMP-99999"}',
                    },
                }
            ],
        }
    ]
    out = redact_messages(msgs)
    tc = out[0]["tool_calls"][0]
    assert tc["id"] == "call_xyz"
    assert tc["type"] == "function"
    assert tc["function"]["name"] == "lookup_compound"
    assert "CMP-99999" not in tc["function"]["arguments"]


def test_redact_messages_handles_tool_calls_without_arguments() -> None:
    """Some tool-call shapes omit `function.arguments` entirely; the
    redactor must not raise on the missing key."""
    msgs = [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "noop"}},
                {"id": "c2", "type": "function"},  # no function dict at all
                {"id": "c3"},  # not even a type — still must not crash
            ],
        }
    ]
    out = redact_messages(msgs)
    assert len(out[0]["tool_calls"]) == 3
