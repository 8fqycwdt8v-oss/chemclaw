# Runbook: Change LLM provider or model assignment

ChemClaw routes every LLM call through LiteLLM (`services/litellm/config.yaml`).
The agent picks a model via four role aliases (`AGENT_MODEL_PLANNER`,
`AGENT_MODEL_EXECUTOR`, `AGENT_MODEL_COMPACTOR`, `AGENT_MODEL_JUDGE`).
Adding a new model or reassigning a role is a config-only change.

## 1. Add a new model

Edit `services/litellm/config.yaml`:

```yaml
model_list:
  - model_name: gpt-5
    litellm_params:
      model: openai/gpt-5
      api_key: os.environ/OPENAI_API_KEY
```

Set the env var in the deployment (Helm secret or `.env`):

```bash
export OPENAI_API_KEY=sk-…
```

Restart LiteLLM:

```bash
docker compose restart litellm
# or kubectl rollout restart deploy/litellm
```

## 2. Reassign a role to the new model

The agent reads the role aliases at startup. Update `.env`:

```bash
AGENT_MODEL_EXECUTOR=gpt-5
```

Restart the agent:

```bash
docker compose restart agent-claw
```

## 3. (Phase 2) Per-tenant model override

If only one org should get the new model, leave the global env var alone
and use `config_settings`:

```bash
curl -X PATCH -H "x-user-entra-id: $YOU" \
  -H "content-type: application/json" \
  -d '{"value":"gpt-5","description":"acme tries gpt-5 for executor"}' \
  "$AGENT_BASE_URL/api/admin/config/org/acme?key=agent.model.executor"
```

The agent reads `agent.model.<role>` via the ConfigRegistry singleton with
60s cache. Per-org rows override the env-var defaults; rows can be deleted
to revert.

## 4. Verify

- `curl $AGENT_BASE_URL/healthz` → 200.
- Run a chat turn:
  ```bash
  curl -X POST -H "x-user-entra-id: $YOU" \
    -H "content-type: application/json" \
    -d '{"messages":[{"role":"user","content":"ping"}]}' \
    "$AGENT_BASE_URL/api/chat"
  ```
- Check Langfuse trace (if observability profile is enabled) — model id
  should match the new assignment.

## Rollback

- For env-var changes: revert and restart. < 30 seconds.
- For per-tenant overrides: `DELETE /api/admin/config/org/<id>?key=…`.
  Effective on the next chat turn (60s cache TTL max latency).

## Cost note

Increase to a more expensive model is reflected in the per-day USD cap
held by Paperclip-lite (`PAPERCLIP_MAX_USD_PER_DAY`). You may need to
raise the cap concurrently or you'll start seeing 429 / cap-exceeded
SSE events.
