#!/usr/bin/env python3
"""Golden-set bootstrap script.

Uses LiteLLM (role='planner') to author N diverse chemistry Q/A pairs
across 4 classes: retrosynthesis, analytical, sop_lookup, cross_project.

Usage:
  python services/optimizer/scripts/seed_golden_set.py \
    --target tests/golden/chem_qa_v1.jsonl \
    --n 100

  python services/optimizer/scripts/seed_golden_set.py \
    --target tests/golden/chem_qa_holdout_v1.jsonl \
    --n 100 --seed 999

This script is NOT run in CI.  It is the production-ready bootstrap for the
full 100-example golden set.  CI uses the 10-example fixtures:
  tests/golden/chem_qa_v1.fixture.jsonl
  tests/golden/chem_qa_holdout_v1.fixture.jsonl

Requirements:
  pip install litellm>=1.0 httpx>=0.27
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from pathlib import Path

CLASSES = ["retrosynthesis", "analytical", "sop_lookup", "cross_project"]

CLASS_PROMPTS = {
    "retrosynthesis": (
        "Write a challenging retrosynthesis Q&A pair for a pharmaceutical chemist. "
        "The question should ask about retrosynthetic strategies or reaction mechanisms. "
        "The answer must be specific, scientifically accurate, 3-6 sentences."
    ),
    "analytical": (
        "Write a challenging analytical chemistry Q&A pair. "
        "Topics: HPLC, NMR, MS, dissolution, method validation, ICH guidelines. "
        "The answer must cite specific parameters, standards, or guidelines."
    ),
    "sop_lookup": (
        "Write a Q&A pair about a laboratory standard operating procedure. "
        "Topics: safety, handling hazardous materials, instrument calibration, quality systems. "
        "The answer must give a step-by-step or procedural response."
    ),
    "cross_project": (
        "Write a Q&A pair about cross-project learning in pharmaceutical development. "
        "The question compares data or findings across multiple projects. "
        "The answer synthesizes patterns and provides actionable conclusions."
    ),
}


def generate_qa_pair(class_name: str, client: object, model: str) -> dict:
    """Call LiteLLM to generate a single Q/A pair."""
    import litellm  # type: ignore

    prompt = CLASS_PROMPTS[class_name]
    system = (
        "You are a pharmaceutical chemistry expert who creates precise, factual Q&A "
        "training examples for AI systems. Output JSON only:\n"
        '{"question": "...", "answer": "...", "notes": "brief meta-note"}'
    )

    resp = litellm.completion(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        temperature=0.8,
        response_format={"type": "json_object"},
    )
    text = resp.choices[0].message.content or "{}"
    pair = json.loads(text)
    pair["expected_classes"] = [class_name]
    pair["expected_fact_ids"] = []
    return pair


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed chemistry Q/A golden set via LiteLLM")
    parser.add_argument("--target", required=True, help="Output .jsonl path")
    parser.add_argument("--n", type=int, default=100, help="Total examples to generate")
    parser.add_argument("--model", default=os.environ.get("LITELLM_PLANNER_MODEL", "openai/gpt-4o"))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--litellm-base-url",
        default=os.environ.get("LITELLM_BASE_URL", "http://localhost:4000"),
    )
    args = parser.parse_args()

    random.seed(args.seed)
    target = Path(args.target)
    target.parent.mkdir(parents=True, exist_ok=True)

    # Distribute evenly across classes.
    per_class = args.n // len(CLASSES)
    extra = args.n % len(CLASSES)
    counts = {cls: per_class for cls in CLASSES}
    for cls in CLASSES[:extra]:
        counts[cls] += 1

    print(f"Generating {args.n} examples: {counts}")
    print(f"Model: {args.model} via {args.litellm_base_url}")

    try:
        import litellm  # type: ignore
        litellm.api_base = args.litellm_base_url
    except ImportError:
        print("ERROR: litellm not installed. pip install litellm", file=sys.stderr)
        sys.exit(1)

    examples = []
    for cls, count in counts.items():
        print(f"  Generating {count} {cls} examples...")
        for i in range(count):
            try:
                pair = generate_qa_pair(cls, litellm, args.model)
                examples.append(pair)
                if (i + 1) % 10 == 0:
                    print(f"    {i + 1}/{count} done")
            except Exception as exc:
                print(f"    WARN: failed example {i}: {exc}")

    random.shuffle(examples)

    with open(target, "w") as f:
        for ex in examples:
            f.write(json.dumps(ex) + "\n")

    print(f"\nWrote {len(examples)} examples to {target}")


if __name__ == "__main__":
    main()
