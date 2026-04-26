"""Scripted driver for fake-litellm.

Watches /tmp/fake-llm/inbox/ for new requests. For each request, decides
the next move from a small rule table per scenario:

  - If the LAST message is `user` (i.e., the agent just got a fresh
    prompt) → emit the *initial tool call* the scenario expects.
  - If the LAST message is `tool` (i.e., a tool returned) → emit either:
      * the next tool call (if there's more work), or
      * the final assistant message (if we've hit the scenario's exit
        condition).

Each scenario is a small Python module under ./scenarios/<name>.py
exposing a function ``decide(request_payload) -> dict`` that returns
the reply (in fake-llm reply format).

Usage:
    python -m tools.fake_litellm.scripted_driver --scenario s2_cross_source

Logs every decision to /tmp/fake-llm/decisions.jsonl for audit.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
import sys
import time
from pathlib import Path

INBOX = Path(os.environ.get("FAKE_LLM_INBOX", "/tmp/fake-llm/inbox"))
OUTBOX = Path(os.environ.get("FAKE_LLM_OUTBOX", "/tmp/fake-llm/outbox"))
DECISIONS = Path("/tmp/fake-llm/decisions.jsonl")


def _last_role(messages: list[dict]) -> str | None:
    for m in reversed(messages):
        return m.get("role")
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", required=True, help="scenario module (e.g., s2_cross_source)")
    parser.add_argument("--manual-on-uncertain", action="store_true",
                        help="If the scenario raises a 'manual' signal, stop and wait for human")
    args = parser.parse_args()

    sys.path.insert(0, str(Path(__file__).parent / "scenarios"))
    scenario = importlib.import_module(args.scenario)

    print(f"[scripted-driver] scenario={args.scenario} watching {INBOX}", flush=True)
    seen: set[str] = set()
    while True:
        files = sorted(INBOX.glob("*.json"))
        for f in files:
            if f.name in seen:
                continue
            seen.add(f.name)
            request_id = f.stem
            try:
                payload = json.loads(f.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                time.sleep(0.1)
                seen.discard(f.name)
                continue

            messages = payload.get("messages", [])
            print(f"[scripted-driver] decide on {request_id}  last_role={_last_role(messages)}  "
                  f"msg_count={len(messages)}", flush=True)
            try:
                reply = scenario.decide(payload)
            except scenario.Manual as why:  # type: ignore[attr-defined]
                print(f"[scripted-driver] HUMAN NEEDED on {request_id}: {why}", flush=True)
                if not args.manual_on_uncertain:
                    raise
                # Wait for human to drop the file
                target = OUTBOX / f"{request_id}.json"
                while not target.exists():
                    time.sleep(0.5)
                continue

            target = OUTBOX / f"{request_id}.json"
            target.write_text(json.dumps(reply, indent=2), encoding="utf-8")
            with DECISIONS.open("a", encoding="utf-8") as logf:
                logf.write(json.dumps({
                    "ts": time.time(),
                    "request_id": request_id,
                    "scenario": args.scenario,
                    "reply_kind": "tool_calls" if "tool_calls" in reply.get("message", {}) else "final",
                }) + "\n")
            print(f"[scripted-driver] replied {request_id}  kind="
                  f"{'tool_calls' if 'tool_calls' in reply.get('message', {}) else 'final'}", flush=True)
        time.sleep(0.3)


if __name__ == "__main__":
    sys.exit(main())
