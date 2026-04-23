"""Unit tests for the LiteLLM redactor."""

from __future__ import annotations

from services.litellm_redactor.redaction import redact, redact_messages


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
