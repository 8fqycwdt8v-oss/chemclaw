#!/usr/bin/env bash
# MCP roll-call — assert every service in SERVICE_SCOPES answers /healthz.
#
# Closes the observability gap from the 2026-05-09 MCP-landscape audit:
# previously, smoke.sh only checked mcp-drfp + agent-claw, so a service
# that failed to start would surface as a tool-call timeout mid-conversation
# rather than an immediate boot-time signal.
#
# Three exit conditions:
#   0 — every reachable service returned 2xx on /healthz
#   1 — at least one service did not respond (or returned non-2xx)
#   2 — usage error (curl missing, no .env, etc.)
#
# Override the binding host with MCP_ROLLCALL_HOST=<host> (default localhost).
# The script does not mint Bearer tokens — /healthz is auth-exempt by design
# (see services/mcp_tools/common/app.py); that's why this can run from a
# laptop without MCP_AUTH_SIGNING_KEY.
#
# Usage:
#   ./scripts/mcp-rollcall.sh                  # all services
#   ./scripts/mcp-rollcall.sh --include-readyz # also probe /readyz
#   ./scripts/mcp-rollcall.sh --json           # machine-readable output

set -uo pipefail

cd "$(dirname "$0")/.."

HOST="${MCP_ROLLCALL_HOST:-localhost}"
TIMEOUT_S="${MCP_ROLLCALL_TIMEOUT_S:-2}"
INCLUDE_READYZ=0
EMIT_JSON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-readyz) INCLUDE_READYZ=1 ;;
    --json)           EMIT_JSON=1 ;;
    -h|--help)
      sed -n '2,/^set/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v curl >/dev/null || { echo "curl not found" >&2; exit 2; }

# Service → port. Source of truth for ports is docker-compose.yml; this
# table is the human-readable mirror that needs to track it. The scope
# names match SERVICE_SCOPES (services/mcp_tools/common/scopes.py +
# services/agent-claw/src/security/mcp-token-cache.ts) so an operator
# reading the output can trace it back.
SERVICES=(
  "mcp-rdkit:8001"
  "mcp-drfp:8002"
  "mcp-kg:8003"
  "mcp-embedder:8004"
  "mcp-tabicl:8005"
  "mcp-doc-fetcher:8006"
  "mcp-askcos:8007"
  "mcp-aizynth:8008"
  "mcp-chemprop:8009"
  "mcp-xtb:8010"
  "mcp-synthegy-mech:8011"
  "mcp-sirius:8012"
  "mcp-eln-local:8013"
  "mcp-crest:8014"
  "mcp-yield-baseline:8015"
  "mcp-logs-sciy:8016"
  "mcp-applicability-domain:8017"
  "mcp-reaction-optimizer:8018"
  "mcp-green-chemistry:8019"
  "mcp-plate-designer:8020"
  "mcp-ord-io:8021"
  "mcp-genchem:8023"
)

probe_one() {
  local name="$1" port="$2" path="$3"
  local url="http://${HOST}:${port}${path}"
  # curl --write-out emits the status code even on connection failure
  # (000 means "never got a response"). The wrapping conditional is so
  # set -e — if it ever returns to this script — doesn't trip on the
  # non-zero exit; we want curl's exit code reflected in the printed code.
  local code
  if code=$(curl --max-time "$TIMEOUT_S" --silent --output /dev/null \
                 --write-out "%{http_code}" "$url" 2>/dev/null); then
    :
  fi
  echo "${code:-000}"
}

PASS=()
FAIL=()
declare -A FAIL_REASONS

for entry in "${SERVICES[@]}"; do
  name="${entry%%:*}"
  port="${entry##*:}"

  health_code=$(probe_one "$name" "$port" "/healthz")
  if [[ "$health_code" =~ ^2 ]]; then
    if [[ $INCLUDE_READYZ -eq 1 ]]; then
      ready_code=$(probe_one "$name" "$port" "/readyz")
      if [[ "$ready_code" =~ ^2 ]]; then
        PASS+=("$name")
      else
        FAIL+=("$name")
        FAIL_REASONS["$name"]="healthz=$health_code readyz=$ready_code"
      fi
    else
      PASS+=("$name")
    fi
  else
    FAIL+=("$name")
    if [[ "$health_code" == "000" ]]; then
      FAIL_REASONS["$name"]="unreachable on ${HOST}:${port}"
    else
      FAIL_REASONS["$name"]="healthz=$health_code"
    fi
  fi
done

if [[ $EMIT_JSON -eq 1 ]]; then
  printf '{"host":"%s","timeout_s":%s,"include_readyz":%s,"pass":[' \
    "$HOST" "$TIMEOUT_S" "$INCLUDE_READYZ"
  for i in "${!PASS[@]}"; do
    [[ $i -gt 0 ]] && printf ','
    printf '"%s"' "${PASS[$i]}"
  done
  printf '],"fail":['
  for i in "${!FAIL[@]}"; do
    [[ $i -gt 0 ]] && printf ','
    printf '{"name":"%s","reason":"%s"}' "${FAIL[$i]}" "${FAIL_REASONS[${FAIL[$i]}]}"
  done
  printf ']}\n'
else
  printf "MCP roll-call against %s (timeout %ss)\n" "$HOST" "$TIMEOUT_S"
  printf "%-30s %s\n" "service" "result"
  printf -- "----------------------------- --------\n"
  for name in "${PASS[@]}"; do
    printf "%-30s OK\n" "$name"
  done
  for name in "${FAIL[@]}"; do
    printf "%-30s FAIL (%s)\n" "$name" "${FAIL_REASONS[$name]}"
  done
  printf "\nPassed: %d / %d\n" "${#PASS[@]}" "${#SERVICES[@]}"
fi

if [[ ${#FAIL[@]} -gt 0 ]]; then
  exit 1
fi
exit 0
