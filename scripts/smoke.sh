#!/usr/bin/env bash
# End-to-end smoke test.
# Brings up data layer + mcp tools + vectorizer, imports sample data, and
# verifies DRFP vectors populate within 60s.

set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf "\n\033[36m▶ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m✓ %s\033[0m\n" "$*"; }
fail() { printf "\033[31m✗ %s\033[0m\n" "$*"; exit 1; }

step "0. Checking prerequisites"
command -v docker >/dev/null || fail "docker not found"
docker compose version >/dev/null 2>&1 || fail "docker compose not found"
[[ -f .env ]] || { cp .env.example .env; ok "created .env from .env.example"; }

step "1. Starting data layer + MCP tools + projector"
docker compose up -d \
  postgres neo4j mcp-rdkit mcp-drfp reaction-vectorizer

step "2. Waiting for Postgres"
for i in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U chemclaw -d chemclaw >/dev/null 2>&1; then
    ok "Postgres ready"; break
  fi
  sleep 1; [[ $i -eq 60 ]] && fail "Postgres not ready in 60s"
done

step "3. Applying schema"
docker compose exec -T postgres psql -U chemclaw -d chemclaw -v ON_ERROR_STOP=1 < db/init/01_schema.sql >/dev/null
ok "schema applied"

step "4. Seeding"
docker compose exec -T postgres psql -U chemclaw -d chemclaw -v ON_ERROR_STOP=1 < db/seed/01_sample_data.sql >/dev/null
ok "seed applied"

step "5. Waiting for mcp-drfp"
for i in $(seq 1 60); do
  if curl -sf http://localhost:8002/healthz >/dev/null; then ok "mcp-drfp ready"; break; fi
  sleep 1; [[ $i -eq 60 ]] && fail "mcp-drfp not ready in 60s"
done

step "6. Smoke-testing mcp-drfp directly"
body='{"rxn_smiles":"N#Cc1ccc(Br)cc1.OB(O)c1ccccc1>>N#Cc1ccc(-c2ccccc2)cc1"}'
on_bits=$(curl -sf -X POST http://localhost:8002/tools/compute_drfp \
  -H 'Content-Type: application/json' -d "$body" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['on_bit_count'])")
[[ "$on_bits" -gt 0 ]] || fail "DRFP returned zero on-bits"
ok "DRFP sanity check: on_bit_count=$on_bits"

step "7. Smoke-testing mcp-rdkit directly"
canonical=$(curl -sf -X POST http://localhost:8001/tools/canonicalize_smiles \
  -H 'Content-Type: application/json' -d '{"smiles":"N#Cc1ccc(-c2ccccc2)cc1"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['canonical_smiles'])")
[[ -n "$canonical" ]] || fail "mcp-rdkit returned empty canonical SMILES"
ok "mcp-rdkit canonical: $canonical"

step "8. Importing sample ELN JSON"
if [[ -d .venv ]]; then PYTHON=.venv/bin/python; else PYTHON=python3; fi
$PYTHON -m services.ingestion.eln_json_importer.cli \
  --input sample-data/eln-experiments-sample.json

step "9. Waiting for DRFP vectors to populate"
for i in $(seq 1 60); do
  pop=$(docker compose exec -T postgres psql -U chemclaw -d chemclaw -tAc \
    "SELECT count(*) FROM reactions WHERE drfp_vector IS NOT NULL;")
  pop=${pop//[$'\t\r\n ']}
  [[ "${pop:-0}" -ge 2 ]] && { ok "DRFP populated: $pop reactions"; break; }
  sleep 1
  [[ $i -eq 60 ]] && fail "DRFP vectors did not populate in 60s (current=$pop)"
done

step "10. Verifying ingestion events were acked"
acked=$(docker compose exec -T postgres psql -U chemclaw -d chemclaw -tAc \
  "SELECT count(*) FROM projection_acks WHERE projector_name='reaction_vectorizer';")
acked=${acked//[$'\t\r\n ']}
[[ "${acked:-0}" -ge 3 ]] || fail "expected ≥3 acks, got $acked"
ok "projection_acks for reaction_vectorizer: $acked"

printf "\n\033[32mAll sprint-2 smoke checks passed.\033[0m\n"
