# chemclaw — minimal CLI for the ChemClaw agent

Wraps `agent-claw`'s `/api/chat` SSE endpoint. Replaces the Streamlit
frontend for local testing. The production frontend will live in a
separate repository.

## Install

From the repo root:

    pip install -e tools/cli

Or via `make setup`, which does the same thing.

## Use

Bring up the stack first:

    make up
    make run.agent

Then:

    chemclaw chat "what is the yield of reaction X?"
    chemclaw chat --resume "and side products?"
    chemclaw chat --session <uuid> "..."
    chemclaw chat --verbose "..."

## Configuration

| Env var               | Default                  | Purpose                                          |
|-----------------------|--------------------------|--------------------------------------------------|
| `CHEMCLAW_USER`       | `dev@local.test`         | Sent as `x-user-entra-id` for RLS                |
| `CHEMCLAW_AGENT_URL`  | `http://localhost:3101`  | Base URL of agent-claw                           |
| `CHEMCLAW_CONFIG_DIR` | `~/.chemclaw`            | Where the per-user last-session file is written  |

## Exit codes

| Code | Meaning                                     |
|------|---------------------------------------------|
| 0    | Stream finished normally (`finish` event)   |
| 1    | Server error (HTTP 5xx) or `error` event    |
| 2    | Agent paused with `awaiting_user_input`     |
| 3    | Could not connect to agent-claw             |
| 4    | Auth rejected (HTTP 401/403)                |
| 5    | `--resume` with no stored session for user  |
| 130  | KeyboardInterrupt                           |
