#!/usr/bin/env bash
# Smoke check for the Loki / Promtail / Grafana stack.
#
# Usage:
#   docker compose --profile observability up -d
#   ./scripts/check-logs-pipeline.sh
#
# What it does:
#   1. Waits up to 60s for Loki to report ready.
#   2. Pushes a test log line to Loki via the HTTP API.
#   3. Queries Loki and asserts the line came back with the right labels.
#   4. Optional: hits Grafana's /api/health to confirm provisioning came up.
#
# Designed to be runnable from CI and a developer's laptop. No JSON
# parsing libraries assumed beyond `python3 -m json.tool`.

set -euo pipefail

LOKI_URL="${LOKI_URL:-http://127.0.0.1:3100}"
GRAFANA_URL="${GRAFANA_URL:-http://127.0.0.1:3001}"

step()  { printf "\033[1;34m▶\033[0m %s\n" "$*"; }
ok()    { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
fail()  { printf "\033[1;31m✗\033[0m %s\n" "$*" 1>&2; exit 1; }

wait_for_loki() {
  step "waiting for Loki at $LOKI_URL"
  for i in $(seq 1 30); do
    if curl -sf "$LOKI_URL/ready" >/dev/null 2>&1; then
      ok "Loki ready"
      return 0
    fi
    sleep 2
  done
  fail "Loki not ready after 60s"
}

push_test_line() {
  step "pushing a test log line"
  local ts_ns
  ts_ns=$(date +%s%N)
  local body
  body=$(cat <<JSON
{
  "streams": [
    {
      "stream": { "service": "logs-pipeline-check", "level": "info" },
      "values": [
        ["${ts_ns}", "{\"event\":\"smoke_test\",\"message\":\"hello from check-logs-pipeline.sh\",\"trace_id\":\"abcdef0123456789\",\"request_id\":\"smoke-$$\"}"]
      ]
    }
  ]
}
JSON
)
  local resp
  resp=$(curl -sS -X POST "$LOKI_URL/loki/api/v1/push" \
    -H "Content-Type: application/json" \
    --data-raw "$body" -w "%{http_code}" -o /tmp/check-logs-push.out || true)
  if [[ "$resp" != "204" && "$resp" != "200" ]]; then
    cat /tmp/check-logs-push.out 1>&2 || true
    fail "push to Loki returned HTTP $resp"
  fi
  ok "test line pushed"
}

query_back() {
  step "querying Loki for the test line"
  # Give Loki a moment to ingest.
  sleep 2
  local q='{service="logs-pipeline-check"}'
  local resp
  resp=$(curl -sf -G --data-urlencode "query=${q}" "$LOKI_URL/loki/api/v1/query_range")
  if [[ -z "$resp" ]]; then
    fail "empty response from Loki query"
  fi
  if echo "$resp" | grep -q "smoke_test"; then
    ok "test line round-tripped through Loki"
  else
    echo "$resp" | python3 -m json.tool 1>&2 || echo "$resp" 1>&2
    fail "test line not found in Loki query response"
  fi
}

grafana_health() {
  step "checking Grafana at $GRAFANA_URL"
  if curl -sf "$GRAFANA_URL/api/health" >/dev/null; then
    ok "Grafana healthy"
  else
    printf "\033[1;33m⚠\033[0m Grafana not reachable at %s — skipping (it is optional)\n" "$GRAFANA_URL"
  fi
}

wait_for_loki
push_test_line
query_back
grafana_health

ok "logs pipeline check complete"
