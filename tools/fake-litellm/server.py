"""Fake LiteLLM — OpenAI-compatible /v1/chat/completions that hands every
request off to a human (or a scripted driver) and returns whatever the
human writes.

Workflow:
  1. agent-claw POSTs /v1/chat/completions
  2. server writes the request payload to /tmp/fake-llm/inbox/<id>.json
  3. server polls /tmp/fake-llm/outbox/<id>.json every 200 ms
  4. once the file appears, the server returns its contents to the agent
     (with a proper OpenAI envelope)

Streaming (`stream: true`):
  - The reply file should contain `{message: {role: "assistant", content: "..."}}`
    OR `{message: {role: "assistant", tool_calls: [...]}}`
  - Server emits the content as one big SSE chunk, then a final [DONE].
    (No char-by-char streaming — overkill for testing.)

Tool calls vs final answer:
  - To make the agent call a tool, the reply file must contain
      {"message": {"role": "assistant", "tool_calls": [{
        "id": "call_001",
        "type": "function",
        "function": {"name": "...", "arguments": "<json-string>"}
      }]}}
  - For a final answer, the reply file is
      {"message": {"role": "assistant", "content": "..."}}
  - finish_reason is inferred ("tool_calls" or "stop").

Env:
  - FAKE_LLM_PORT (default 4000)
  - FAKE_LLM_TIMEOUT_S (default 600 — how long to wait for the human)
  - FAKE_LLM_INBOX (default /tmp/fake-llm/inbox)
  - FAKE_LLM_OUTBOX (default /tmp/fake-llm/outbox)
  - FAKE_LLM_TRACE (default /tmp/fake-llm/trace.jsonl) — every request+reply
    appended for post-hoc auditing.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse


PORT = int(os.environ.get("FAKE_LLM_PORT", "4000"))
TIMEOUT_S = float(os.environ.get("FAKE_LLM_TIMEOUT_S", "600"))
INBOX = Path(os.environ.get("FAKE_LLM_INBOX", "/tmp/fake-llm/inbox"))
OUTBOX = Path(os.environ.get("FAKE_LLM_OUTBOX", "/tmp/fake-llm/outbox"))
TRACE = Path(os.environ.get("FAKE_LLM_TRACE", "/tmp/fake-llm/trace.jsonl"))

INBOX.mkdir(parents=True, exist_ok=True)
OUTBOX.mkdir(parents=True, exist_ok=True)
TRACE.parent.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="fake-litellm")


def _new_id() -> str:
    return time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:6]


def _wrap_envelope(reply: dict[str, Any], request_id: str, model: str) -> dict[str, Any]:
    msg = reply.get("message", {"role": "assistant", "content": ""})
    if "tool_calls" in msg:
        finish = "tool_calls"
    else:
        finish = reply.get("finish_reason", "stop")
    return {
        "id": "chatcmpl-" + request_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
        "usage": {
            "prompt_tokens": reply.get("prompt_tokens", 100),
            "completion_tokens": reply.get("completion_tokens", 50),
            "total_tokens": reply.get("total_tokens", 150),
        },
    }


async def _wait_for_reply(request_id: str) -> dict[str, Any]:
    target = OUTBOX / f"{request_id}.json"
    deadline = time.time() + TIMEOUT_S
    while time.time() < deadline:
        if target.exists():
            try:
                data = json.loads(target.read_text(encoding="utf-8"))
                target.unlink(missing_ok=True)
                return data
            except json.JSONDecodeError as exc:
                # Wait a beat; the writer may still be flushing.
                await asyncio.sleep(0.05)
                continue
        await asyncio.sleep(0.2)
    raise HTTPException(
        status_code=504,
        detail=f"fake-litellm: timed out waiting for {target} after {TIMEOUT_S}s",
    )


def _stream_chunks(envelope: dict[str, Any]):
    """Yield SSE frames for streaming responses.

    We chunk the assistant content (or tool_calls metadata) as a single
    delta, then a finish-reason delta, then [DONE]. Real LLM streams
    fragment further; this is enough to make the agent's stream parser
    happy.
    """
    request_id = envelope["id"]
    model = envelope["model"]
    msg = envelope["choices"][0]["message"]
    finish = envelope["choices"][0]["finish_reason"]

    # First chunk: role only
    first = {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": envelope["created"],
        "model": model,
        "choices": [{"index": 0, "delta": {"role": msg.get("role", "assistant")}, "finish_reason": None}],
    }
    yield f"data: {json.dumps(first)}\n\n"

    if "tool_calls" in msg and msg["tool_calls"]:
        # Stream tool_calls in one chunk (OpenAI streaming actually
        # spreads name + arguments across many chunks; one chunk works
        # too, the AI SDK accepts both).
        delta = {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": envelope["created"],
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {"tool_calls": [
                    {
                        "index": i,
                        "id": tc.get("id", f"call_{i:03d}"),
                        "type": tc.get("type", "function"),
                        "function": tc.get("function", {}),
                    }
                    for i, tc in enumerate(msg["tool_calls"])
                ]},
                "finish_reason": None,
            }],
        }
        yield f"data: {json.dumps(delta)}\n\n"
    else:
        content = msg.get("content", "") or ""
        delta = {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": envelope["created"],
            "model": model,
            "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
        }
        yield f"data: {json.dumps(delta)}\n\n"

    # Final chunk: finish_reason
    final = {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": envelope["created"],
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
    }
    yield f"data: {json.dumps(final)}\n\n"
    yield "data: [DONE]\n\n"


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "fake-litellm",
        "inbox": str(INBOX),
        "outbox": str(OUTBOX),
        "trace": str(TRACE),
    }


@app.post("/v1/chat/completions")
async def chat_completions(req: Request):
    payload = await req.json()
    request_id = _new_id()

    # Stash the request for the human to read.
    inbox_path = INBOX / f"{request_id}.json"
    inbox_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    # Surface the request shape on stdout so the operator sees it.
    msgs = payload.get("messages", [])
    last_user = next((m for m in reversed(msgs) if m.get("role") == "user"), None)
    last_tool = next((m for m in reversed(msgs) if m.get("role") == "tool"), None)
    role_hint = payload.get("metadata", {}).get("role") or payload.get("model", "?")
    tool_count = len(payload.get("tools", []) or [])
    print(
        f"\n>>> [fake-llm] request {request_id}  model={payload.get('model','?')}  "
        f"messages={len(msgs)}  tools={tool_count}  stream={payload.get('stream', False)}",
        flush=True,
    )
    if last_user:
        snippet = (last_user.get("content") or "")[:120].replace("\n", " ")
        print(f"    last user: {snippet}", flush=True)
    if last_tool:
        snippet = (last_tool.get("content") or "")[:120].replace("\n", " ")
        print(f"    last tool: {snippet}", flush=True)
    print(f"    awaiting: {OUTBOX}/{request_id}.json", flush=True)

    # Wait for the human (or scripted driver) to drop a reply.
    reply = await _wait_for_reply(request_id)

    envelope = _wrap_envelope(reply, request_id, payload.get("model", "fake-model"))

    # Audit trail
    with TRACE.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "id": request_id,
            "ts": time.time(),
            "model": payload.get("model"),
            "stream": payload.get("stream", False),
            "messages": msgs,
            "tools_offered": [t.get("function", {}).get("name") for t in (payload.get("tools") or [])],
            "reply": reply,
        }) + "\n")

    if payload.get("stream"):
        return StreamingResponse(
            _stream_chunks(envelope),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )
    return envelope


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
