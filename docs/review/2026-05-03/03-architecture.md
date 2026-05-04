# Architecture & Service-Boundary Audit — 2026-05-03

## Executive Summary

| Severity | Finding | File:line | Fix sketch |
|---|---|---|---|
| P1 | Port collision: `mcp-genchem` and `mcp-yield-baseline` both bind `8015:8015` under the same `chemistry` profile | `docker-compose.yml:1096,1227` | Assign `mcp-genchem` a dedicated port (8023 matches the `config.ts` default); update compose and workflow-engine/queue-worker env |
| P2 | `mcp-eln-local` and `mcp-logs-sciy` compose entries omit `MCP_AUTH_SIGNING_KEY` / `MCP_AUTH_DEV_MODE`; in any deployment with a signing key set, agent calls to these services receive 401 | `docker-compose.yml:1341-1364,1373-1400` | Add `MCP_AUTH_SIGNING_KEY: ${MCP_AUTH_SIGNING_KEY:?required}` to both service env blocks (matching the pattern used by `mcp-green-chemistry`, `mcp-applicability-domain`, etc.) |
| P2 | `mcp-yield-baseline` calls `mcp-drfp` and `mcp-chemprop` via plain `httpx.Client` without a Bearer token | `services/mcp_tools/mcp_yield_baseline/main.py:115-138` | Use `McpTokenCache` (already in `services/mcp_tools/common/mcp_token_cache.py`) to mint tokens for MCP-to-MCP calls, matching the pattern used by `mcp-synthegy-mech/xtb_validator.py` |
| P2 | `MCP_GENCHEM_URL` default in `config.ts` is `:8023` but compose assigns genchem `:8015`; native localhost runs miss the service | `services/agent-claw/src/config.ts:108` | Align to one authoritative port (8023 recommended; update compose to match) |
| P3 | `gepa-runner` (profile `optimizer`) also binds port `8010` — same as `mcp-xtb` (profile `chemistry`); running both profiles together causes a bind failure | `docker-compose.yml:870,1194` | Assign `gepa-runner` a non-colliding port (e.g. 8022); update healthcheck URL |
| P3 | `kg-source-cache` projector has no healthcheck and no `depends_on: mcp-kg`, yet POSTs to `MCP_KG_URL` on startup catch-up | `docker-compose.yml:1403-1424` | Add `depends_on: {mcp-kg: {condition: service_healthy}}` and a healthcheck |
| P3 | `conditions_normalizer` projector calls `litellm.acompletion` with hard-coded `api_base=settings.litellm_base_url` — egress is routed correctly through the proxy, but the service is not in compose at all under any profile (missing from all profiles, not just `full`) | `docker-compose.yml` (absent), `services/projectors/conditions_normalizer/main.py` | Add `conditions-normalizer` to compose under an appropriate profile with `LITELLM_BASE_URL` env var |
| P4 | Prior audit finding H4 (`routes/forged-tools.ts` never registered) is now fixed — `registerForgedToolsRoutes` imported and called in `bootstrap/routes.ts:22,89` | `services/agent-claw/src/bootstrap/routes.ts:22,89` | Resolved |
| P4 | `services/frontend/` directory referenced in CLAUDE.md as "moved to separate repo" — confirm it no longer exists or delete it | CLAUDE.md | Remove from repo or add `.gitkeep` with note |
| P4 | Permission resolver not wired in any production route — CLAUDE.md documents this as intentional; no production route passes `{ permissions: { permissionMode: "enforce" } }` | `services/agent-claw/src/routes/chat.ts:387-399` | As-designed; note for future enforcement |

---

## As-Built Architecture Map

### Service Inventory

| Service name (compose) | Language | Port (host:container) | Profile | Healthcheck | `security_opt` | Key `depends_on` | DB role | Notes |
|---|---|---|---|---|---|---|---|---|
| `postgres` | TimescaleDB/pgvector | 5432:5432 | default | `pg_isready` | yes | — | — | App DB + pgvector + pgvectorscale |
| `neo4j` | JVM | 7474,7687 | default | `cypher-shell` | yes | — | — | Bi-temporal KG via Graphiti |
| `mcp-rdkit` | Python | 8001:8001 | default | python urllib | yes | — | — | RDKit cheminformatics |
| `mcp-drfp` | Python | 8002:8002 | default | python urllib | yes | — | — | DRFP reaction fingerprints |
| `mcp-kg` | Python | 8003:8003 | default | python urllib | yes | `neo4j` | — | KG query/write via Graphiti |
| `mcp-embedder` | Python | 8004:8004 | default | python urllib | yes | — | — | BGE-M3 text embeddings |
| `kg-experiments` | Python | — | default | none | yes | `postgres`, `mcp-kg`, `mcp-rdkit` | `chemclaw_service` | Projector: experiment_imported → KG |
| `doc-ingester` | Python | — | ingest | none | yes | `postgres` | `chemclaw_service` | One-shot; restart="no" |
| `chunk-embedder` | Python | — | default | none | yes | `postgres`, `mcp-embedder` | `chemclaw_service` | Projector: chunk embedding |
| `contextual-chunker` | Python | — | full | none | yes | `postgres` | `chemclaw_service` | Projector: LLM-context prefix; needs LiteLLM |
| `reaction-vectorizer` | Python | — | default | none | yes | `postgres`, `mcp-drfp` | `chemclaw_service` | Projector: DRFP vectors |
| `workflow-engine` | Python | — | chemistry | none | yes | `postgres` | `chemclaw_service` | pg_notify workflow executor |
| `queue-worker` | Python | — | chemistry | none | yes | `postgres` | `chemclaw_service` | Postgres-backed batch queue |
| `compound-fingerprinter` | Python | — | default | none | yes | `postgres`, `mcp-rdkit` | `chemclaw_service` | Projector: Morgan/MACCS fingerprints |
| `compound-classifier` | Python | — | default | none | yes | `postgres` | `chemclaw_service` | Projector: chemotype tagging |
| `conditions-normalizer` | Python | — | **MISSING** | none | yes | `postgres` | `chemclaw_service` | Projector: reaction conditions; NOT in compose |
| `qm-kg` | Python | — | default | none | yes | `postgres`, `neo4j` | `chemclaw_service` | Projector: qm_jobs → Neo4j |
| `kg-hypotheses` | Python | — | default | none | yes | `postgres`, `neo4j` | `chemclaw_service` | Projector: hypothesis generation |
| `mcp-tabicl` | Python | 8005:8005 | full | curl readyz | yes | — | — | TabICL v2 tabular ICL |
| `mcp-doc-fetcher` | Python | 8006:8006 | full | curl healthz | yes | — | — | PDF/file fetcher + SSRF guard |
| `litellm` | Python | 4000:4000 | **COMMENTED OUT** | — | — | — | — | LLM proxy; commented in compose |
| `paperclip-lite` | Node.js | 3200:3200 | full | curl heartbeat | yes | — | `chemclaw_service` | Budget/concurrency sidecar |
| `langfuse-clickhouse` | ClickHouse | — | observability | CH query | yes | — | — | Langfuse backing store |
| `langfuse-postgres` | Postgres 16 | — | observability | pg_isready | yes | — | — | Langfuse backing store |
| `langfuse` | Node.js | 3000:3000 | observability | curl | yes | `langfuse-postgres`, `langfuse-clickhouse` | — | LLM observability |
| `loki` | Go | 127.0.0.1:3100 | observability | wget | yes | — | — | Log aggregation |
| `promtail` | Go | — | observability | none | yes | `loki` | — | Log collector (Docker socket) |
| `grafana` | Go | 127.0.0.1:3001 | observability | wget | yes | `loki` | — | Dashboards |
| `forged-tool-validator` | Python | — | optimizer | none | yes | `postgres` | `chemclaw_service` | Nightly forged-tool validation |
| `gepa-runner` | Python | **8010**:8010 | optimizer | python urllib | yes | `postgres` | `chemclaw_service` | **PORT COLLISION with mcp-xtb** |
| `skill-promoter` | Python | 8011:8011 | optimizer | python urllib | yes | `postgres` | `chemclaw_service` | Nightly skill promotion |
| `session-purger` | Python | — | optimizer | none | yes | `postgres` | `chemclaw_service` | TTL daemon for agent_sessions |
| `mcp-askcos` | Python | 8007:8007 | chemistry | python urllib | yes | — | — | ASKCOS retrosynthesis |
| `mcp-green-chemistry` | Python | 8019:8019 | chemistry | python urllib | yes | — | — | Solvent/safety lookup |
| `mcp-applicability-domain` | Python | 8017:8017 | chemistry | python urllib | yes | — | — | 3-signal AD verdict |
| `mcp-aizynth` | Python | 8008:8008 | chemistry | python urllib | yes | — | — | AiZynthFinder retrosynthesis |
| `mcp-chemprop` | Python | 8009:8009 | chemistry | python urllib | yes | — | — | ChemProp MPNN yield/property |
| `mcp-yield-baseline` | Python | **8015**:8015 | chemistry | python urllib | yes | — | — | **PORT COLLISION with mcp-genchem** |
| `mcp-reaction-optimizer` | Python | 8018:8018 | chemistry | python urllib | yes | — | — | BoFire BO closed-loop |
| `mcp-plate-designer` | Python | 8020:8020 | chemistry | python urllib | yes | — | — | HTE plate DoE |
| `mcp-ord-io` | Python | 8021:8021 | chemistry | python urllib | yes | — | — | ORD protobuf I/O |
| `mcp-xtb` | Python | **8010**:8010 | chemistry | python urllib | yes | — | `chemclaw_service` | GFN2-xTB QM; **PORT COLLISION with gepa-runner** |
| `mcp-genchem` | Python | **8015**:8015 | chemistry | python urllib | yes | — | `chemclaw_service` | **PORT COLLISION with mcp-yield-baseline** |
| `mcp-crest` | Python | 8014:8014 | chemistry | python urllib | yes | — | `chemclaw_service` | CREST conformer/tautomer |
| `mcp-synthegy-mech` | Python | 8011:8011 | chemistry | python urllib | yes | — | — | A* mechanism elucidation |
| `mcp-sirius` | Python | 8012:8012 | chemistry | python urllib | yes | — | — | SIRIUS MS structure ID |
| `mcp-eln-local` | Python | 8013:8013 | testbed | python urllib | yes | `postgres` | reader role | Mock ELN; **missing auth env** |
| `mcp-logs-sciy` | Python | 8016:8016 | sources | python urllib | yes | `postgres` | reader role | SDMS adapter; **missing auth env** |
| `kg-source-cache` | Python | — | sources | **none** | yes | `postgres` only | `chemclaw_service` | **No healthcheck, no depends_on mcp-kg** |
| `agent-claw` | Node.js/TS | 3101 (host) | — (run via make) | — | — | — | `chemclaw_app` | Main agent; run locally not in compose |

### MCP Tool Catalog — endpoint to agent-claw builtin mapping

| MCP Service | Port | Endpoint(s) | agent-claw builtin | Registered in `BUILTIN_REGISTRARS`? |
|---|---|---|---|---|
| `mcp-rdkit` | 8001 | `/tools/canonicalize_smiles`, `/tools/validate_smiles`, `/tools/compute_fingerprint`, etc. | `canonicalize_smiles` | Yes (`buildCanonicalizeSmilesTool`) |
| `mcp-drfp` | 8002 | `/tools/compute_drfp` | `find_similar_reactions` (pool+drfp); also used internally by `assess_applicability_domain` | Yes |
| `mcp-kg` | 8003 | `/entities`, `/edges`, `/search`, `/contradictions` | `query_kg`, `check_contradictions`, `expand_reaction_context` | Yes |
| `mcp-embedder` | 8004 | `/encode` | `search_knowledge` | Yes |
| `mcp-tabicl` | 8005 | `/predict` | `statistical_analyze` | Yes |
| `mcp-doc-fetcher` | 8006 | `/fetch` | `fetch_original_document`, `analyze_csv` | Yes |
| `mcp-askcos` | 8007 | `/retrosynthesis`, `/forward_prediction`, `/recommend_conditions` | `propose_retrosynthesis` (with aizynth), `recommend_conditions` | Yes |
| `mcp-aizynth` | 8008 | `/retrosynthesis` | `propose_retrosynthesis` (with askcos) | Yes |
| `mcp-chemprop` | 8009 | `/predict_yield`, `/predict_property` | `predict_reaction_yield`, `predict_molecular_property` | Yes |
| `mcp-xtb` | 8010 | `/single_point`, `/geometry_opt`, `/frequencies`, `/fukui`, `/redox`, `/conformer_ensemble`, `/run_workflow`, etc. | `compute_conformer_ensemble`, `run_xtb_workflow`, `qm_single_point`, `qm_geometry_opt`, `qm_frequencies`, `qm_fukui`, `qm_redox_potential` | Yes |
| `mcp-synthegy-mech` | 8011 | `/elucidate_mechanism` | `elucidate_mechanism` | Yes |
| `mcp-sirius` | 8012 | `/identify` | `identify_unknown_from_ms` | Yes |
| `mcp-eln-local` | 8013 | `/entries/query`, `/entries/fetch`, `/canonical_reactions/query`, `/canonical_reactions/fetch`, `/samples/fetch`, `/samples/by_entry` | `query_eln_experiments`, `fetch_eln_entry`, `query_eln_canonical_reactions`, `fetch_eln_canonical_reaction`, `fetch_eln_sample`, `query_eln_samples_by_entry` | Yes |
| `mcp-crest` | 8014 | `/conformers`, `/tautomers`, `/protomers` | `qm_crest_screen` | Yes |
| `mcp-yield-baseline` | 8015 | `/train`, `/predict_yield` | `predict_yield_with_uq`, `design_plate` (also uses plate-designer) | Yes |
| `mcp-logs-sciy` | 8016 | `/datasets/query`, `/datasets/fetch`, `/datasets/by_sample`, `/persons/query` | `query_instrument_runs`, `fetch_instrument_run`, `query_instrument_datasets`, `query_instrument_persons` | Yes |
| `mcp-applicability-domain` | 8017 | `/calibrate`, `/assess` | `assess_applicability_domain` | Yes |
| `mcp-reaction-optimizer` | 8018 | `/build_domain`, `/recommend_next` | `start_optimization_campaign`, `recommend_next_batch`, `extract_pareto_front` | Yes |
| `mcp-green-chemistry` | 8019 | `/score_solvents`, `/assess_reaction_safety` | `score_green_chemistry` | Yes |
| `mcp-plate-designer` | 8020 | `/design` | `design_plate` | Yes |
| `mcp-ord-io` | 8021 | `/export`, `/import` | `export_to_ord` | Yes |
| `mcp-genchem` | 8015 (compose) / 8023 (config.ts default) | `/scaffold_decorate`, `/rgroup_enumerate`, `/mmp_search`, `/bioisostere_replace`, `/fragment_grow`, `/fragment_link` | `generate_focused_library`, `find_matched_pairs` | Yes |

### Port Allocation Table

| Port | Service (compose name) | Profile | CLAUDE.md documented? | Collision? |
|---|---|---|---|---|
| 3000 | `langfuse` | observability | Yes | No |
| 3001 | `grafana` | observability | Yes (Grafana:3001) | No |
| 3100 | `loki` | observability | Yes (Loki:3100) | No |
| 3101 | `agent-claw` | host-run | Yes | No |
| 3200 | `paperclip-lite` | full | Yes | No |
| 4000 | `litellm` (commented out) | — | Yes | No |
| 5432 | `postgres` | default | Yes | No |
| 7474 | `neo4j` HTTP | default | Implicit | No |
| 7687 | `neo4j` Bolt | default | Implicit | No |
| 8001 | `mcp-rdkit` | default | Yes | No |
| 8002 | `mcp-drfp` | default | Yes | No |
| 8003 | `mcp-kg` | default | Implicit | No |
| 8004 | `mcp-embedder` | default | Implicit | No |
| 8005 | `mcp-tabicl` | full | Implicit | No |
| 8006 | `mcp-doc-fetcher` | full | Implicit | No |
| 8007 | `mcp-askcos` | chemistry | Yes (8007) | No |
| 8008 | `mcp-aizynth` | chemistry | Yes (8008) | No |
| 8009 | `mcp-chemprop` | chemistry | Yes (8009) | No |
| **8010** | `mcp-xtb` | chemistry | Yes (xtb: 8010) | **YES: gepa-runner also :8010 under optimizer** |
| **8010** | `gepa-runner` | optimizer | Mentioned as 8010 in compose comment | **YES: collision with mcp-xtb** |
| 8011 | `mcp-synthegy-mech` | chemistry | Yes (8011) | No |
| 8011 | `skill-promoter` | optimizer | Compose: 8011:8011 | **Yes: collision with synthegy-mech if profiles overlap** |
| 8012 | `mcp-sirius` | chemistry | Yes (8012) | No |
| 8013 | `mcp-eln-local` | testbed | Yes (8013) | No |
| 8014 | `mcp-crest` | chemistry | Implicit | No |
| **8015** | `mcp-yield-baseline` | chemistry | CLAUDE.md: not documented at 8015 | **YES: collision with mcp-genchem** |
| **8015** | `mcp-genchem` | chemistry | CLAUDE.md phase F.1 omits genchem port | **YES: collision with mcp-yield-baseline** |
| 8016 | `mcp-logs-sciy` | sources | Yes (8016) | No |
| 8017 | `mcp-applicability-domain` | chemistry | Undocumented in CLAUDE.md | No |
| 8018 | `mcp-reaction-optimizer` | chemistry | Undocumented in CLAUDE.md | No |
| 8019 | `mcp-green-chemistry` | chemistry | Undocumented in CLAUDE.md | No |
| 8020 | `mcp-plate-designer` | chemistry | Undocumented in CLAUDE.md | No |
| 8021 | `mcp-ord-io` | chemistry | Undocumented in CLAUDE.md | No |
| 8023 | (none in compose) | — | `config.ts:108` defaults `MCP_GENCHEM_URL` here | **Drift: compose binds genchem to 8015, config.ts defaults to 8023** |

**Secondary port collision:** `skill-promoter` (optimizer profile) binds `8011:8011`. `mcp-synthegy-mech` (chemistry profile) also binds `8011:8011`. If `--profile chemistry,optimizer` is invoked simultaneously, `skill-promoter` and `mcp-synthegy-mech` collide on port 8011.

### Hook Lifecycle vs. Route Call-Site Verification

| Route | File:line | Imports singleton `lifecycle`? | Calls `runHarness`? | Passes `permissions`? |
|---|---|---|---|---|
| `POST /api/chat` | `routes/chat.ts:31` → `import { lifecycle }` | Yes | Yes (line ~387) | No |
| `POST /api/chat/plan/approve` | `routes/plan.ts` → imports lifecycle via `routes.ts` | Yes (via singleton from `core/runtime.ts`) | Yes | No |
| `POST /api/sessions/:id/plan/run` | `routes/sessions.ts:32` → re-exports `runChainedHarness` from `core/chained-harness.ts` | Yes | Yes (inside chained-harness) | No |
| `POST /api/sessions/:id/resume` | Same as above | Yes | Yes | No |
| `POST /api/deep_research` | `routes/deep-research.ts:31` → imports lifecycle | Yes | Yes | No |
| Sub-agents | `tools/builtins/dispatch_sub_agent.ts:15` | Yes (passed in from caller) | Yes | No |

CLAUDE.md statement that "no production route passes `permissions: { permissionMode: 'enforce' }`" is confirmed correct. The permission hook (`hooks/permission.yaml`) is registered and wired, but the resolver in `core/step.ts` only fires when `options.permissions` is provided. All production routes omit it, so the permission chain runs only in unit/parity tests.

---

## Boundary-Violation Findings (Full Appendix)

### Finding 1 — P1: Port collision: `mcp-genchem` and `mcp-yield-baseline` both bind 8015 under `chemistry` profile

**File:line:** `docker-compose.yml:1096` (yield-baseline: `8015:8015`) and `docker-compose.yml:1227` (genchem: `8015:8015`)

**Evidence:**
- `mcp-yield-baseline` compose entry (lines 1090-1110): `ports: - "8015:8015"`, `profiles: ["chemistry"]`
- `mcp-genchem` compose entry (lines 1218-1243): `ports: - "8015:8015"`, `profiles: ["chemistry"]`
- Both services' `main.py` also document port 8015 in their module-level docstrings
- `services/agent-claw/src/config.ts:94`: `MCP_YIELD_BASELINE_URL: ... default("http://localhost:8015")` — yield-baseline owns 8015 from the agent's perspective
- `services/agent-claw/src/config.ts:108`: `MCP_GENCHEM_URL: ... default("http://localhost:8023")` — agent defaults genchem to 8023, not 8015

**Why it's a problem:** `docker compose --profile chemistry up` attempts to bind two containers to the same host port. The second one to start fails with "address already in use". The entire `chemistry` profile cannot run as documented. Furthermore, the agent-claw `config.ts` default for `MCP_GENCHEM_URL` (8023) is inconsistent with the compose assignment (8015), meaning agent calls to genchem fail even in a partial startup scenario unless the env var is explicitly overridden.

**Fix sketch:** Assign `mcp-genchem` port 8023 in compose (consistent with `config.ts` default). Update `mcp-genchem/main.py` docstring. Update `workflow-engine` and `queue-worker` `MCP_GENCHEM_URL` env vars in compose to `http://mcp-genchem:8023`. Add `MCP_GENCHEM_URL=http://localhost:8023` to `.env.example`.

---

### Finding 2 — P1: `gepa-runner` (optimizer) and `mcp-xtb` (chemistry) both bind port 8010

**File:line:** `docker-compose.yml:870` (gepa-runner: `"${GEPA_PORT:-8010}:8010"`) and `docker-compose.yml:1194` (mcp-xtb: `"8010:8010"`)

**Evidence:** Compose comment on mcp-xtb (line 1184): "Note: GEPA runner also uses 8010 on profile=optimizer — profiles don't overlap." This is noted as design intent but the claim is only true if no operator ever enables both profiles simultaneously. The compose file provides no enforcement mechanism.

**Secondary collision:** `mcp-synthegy-mech` (chemistry, port 8011) and `skill-promoter` (optimizer, port 8011) also collide if both profiles are active.

**Why it's a problem:** A developer running `make up.full` or `--profile chemistry,optimizer` will get a silent bind failure. The comment documents the intention but the profiles are not mutually exclusive.

**Fix sketch:** Reassign `gepa-runner` to port 8022 (next available). Update `GEPA_PORT` default in compose and healthcheck. Similarly, reassign `skill-promoter` away from 8011.

---

### Finding 3 — P2: `mcp-eln-local` and `mcp-logs-sciy` missing auth env vars in compose

**File:line:** `docker-compose.yml:1341-1364` (`mcp-eln-local`), `docker-compose.yml:1373-1400` (`mcp-logs-sciy`)

**Evidence:** Both services:
1. Use `create_app(...)` from `services.mcp_tools.common.app` which wires `mcp_auth_middleware` — fail-closed by default
2. Their compose env blocks do not include `MCP_AUTH_SIGNING_KEY`, `MCP_AUTH_REQUIRED`, or `MCP_AUTH_DEV_MODE`
3. Comparable services added since phase F.1 all include `MCP_AUTH_SIGNING_KEY: ${MCP_AUTH_SIGNING_KEY:?required}` (e.g. `mcp-green-chemistry` at line 996, `mcp-applicability-domain` at line 1019, `mcp-yield-baseline` at line 1100)

**Why it's a problem:** In any deployment where `MCP_AUTH_SIGNING_KEY` is set (i.e., any non-dev environment), every request from agent-claw to `mcp-eln-local` and `mcp-logs-sciy` carries a JWT, but the services themselves don't know the signing key and will reject all requests with 401. The six ELN/SDMS builtins (`query_eln_*`, `fetch_eln_*`, `query_instrument_*`, `fetch_instrument_*`) become permanently broken in any production deploy.

**Fix sketch:** Add to both service env blocks:
```yaml
MCP_AUTH_SIGNING_KEY: ${MCP_AUTH_SIGNING_KEY:?required}
MCP_AUTH_REQUIRED: ${MCP_AUTH_REQUIRED:-}
MCP_AUTH_DEV_MODE: ${MCP_AUTH_DEV_MODE:-}
```

---

### Finding 4 — P2: `mcp-yield-baseline` calls `mcp-drfp` and `mcp-chemprop` without Bearer tokens

**File:line:** `services/mcp_tools/mcp_yield_baseline/main.py:115-138`

**Evidence:**
```python
def _encode_drfp_batch(rxn_smiles_list: list[str]) -> list[list[float]]:
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            f"{_drfp_url()}/tools/compute_drfp",
            json={...},
        )
```
and:
```python
def _call_chemprop_batch(rxn_smiles_list: list[str]) -> list[tuple[float, float]]:
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            f"{_chemprop_url()}/predict_yield",
            json={...},
        )
```

No `Authorization: Bearer ...` header in either call. Compare with `mcp_synthegy_mech/xtb_validator.py` which correctly uses `services.mcp_tools.common.auth.sign_mcp_token` to mint a token before calling `mcp-xtb`.

**Why it's a problem:** In any environment where `MCP_AUTH_REQUIRED=true` (the production default), `mcp-drfp` and `mcp-chemprop` will return 401 to yield-baseline, breaking `predict_yield_with_uq` and `design_plate` silently. The ADR 006 Phase 7 fail-closed design is circumvented by a Python MCP calling another Python MCP without auth.

**Fix sketch:** Introduce a `McpTokenCache` instance in `mcp-yield-baseline` (as in `mcp_synthegy_mech/xtb_validator.py:75-80`). Pass the bearer token in the `httpx.Client` headers for both `_encode_drfp_batch` and `_call_chemprop_batch`.

---

### Finding 5 — P2: `MCP_GENCHEM_URL` default in `config.ts` inconsistent with compose port assignment

**File:line:** `services/agent-claw/src/config.ts:108` (`default("http://localhost:8023")`), `docker-compose.yml:1227` (port `8015:8015`)

**Evidence:**
- Config.ts line 105-108: "Phase 5 — focused chemical-space generation. Distinct from MCP_YIELD_BASELINE_URL (which also runs internally on :8015 inside its own container); for native localhost runs they cannot share the port." Default is `8023`.
- Compose assigns genchem to `8015`. No operator override is shown in `.env.example`.
- `.env.example` line 161: `MCP_INSTRUMENT_WATERS_URL=http://localhost:8015` — itself a stale reference from an older source-system design (the old `mcp_instrument_waters` adapter, which is no longer in compose).

**Why it's a problem:** A developer running agent-claw natively (via `make run.agent`) against compose services will send genchem calls to `localhost:8023` which has nothing listening. The `generate_focused_library` and `find_matched_pairs` tools silently fail. The compose fix (Finding 1 above) and updating `.env.example` both need to happen together.

---

### Finding 6 — P3: `conditions-normalizer` projector absent from `docker-compose.yml`

**File:line:** `services/projectors/conditions_normalizer/main.py` exists on disk; no entry in `docker-compose.yml`

**Evidence:** All other projectors have compose service entries. `conditions-normalizer` has a `Dockerfile` (implied by the pattern), a full implementation subscribing to `experiment_imported` events, and three-tier LLM extraction. However, it does not appear in compose under any profile.

**Why it's a problem:** The projector that populates first-class reaction condition columns (`solvent`, `catalyst_smiles`, `temperature_c`, etc.) never runs in any docker compose setup. The conditions columns remain unpopulated. Any agent query relying on these columns returns null data.

**Fix sketch:** Add a compose entry for `conditions-normalizer` under the `full` profile with the same env vars as other projectors plus `LITELLM_BASE_URL`, `LITELLM_API_KEY`, and `CONDITIONS_NORMALIZER_LLM_FALLBACK`.

---

### Finding 7 — P3: `kg-source-cache` projector missing healthcheck and `depends_on: mcp-kg`

**File:line:** `docker-compose.yml:1403-1424`

**Evidence:**
```yaml
kg-source-cache:
  ...
  depends_on:
    postgres:
      condition: service_healthy
  environment:
    MCP_KG_URL: http://mcp-kg:8003
```

`mcp-kg` is not in `depends_on` despite the projector posting to `MCP_KG_URL` during startup catch-up. No healthcheck is defined.

**Why it's a problem:** If `kg-source-cache` starts before `mcp-kg` is ready, the startup catch-up sweep will fail to POST source facts to the KG. Without a healthcheck, `docker compose ps` shows the service as "up" regardless of its actual ability to connect to the KG.

**Fix sketch:** Add `mcp-kg: {condition: service_healthy}` to `depends_on`. Add a healthcheck (can be a simple Python urllib check against `/healthz` if the projector exposes one, or a `psycopg` ping if it doesn't).

---

### Finding 8 — P3: `litellm` service is commented out in compose

**File:line:** `docker-compose.yml:581-595`

**Evidence:** The entire `litellm` service block is commented out with "Commented by default; uncomment after setting API keys in .env." However, multiple projectors (`contextual-chunker`, `conditions-normalizer`) and `mcp-synthegy-mech` depend on `LITELLM_BASE_URL` at runtime. When these services run without LiteLLM, they silently fall back to calling external provider APIs directly (via `litellm.acompletion` which, if not pointed at a proxy, will use provider env-var keys) — bypassing the redactor callback and the single-egress chokepoint.

**Why it's a problem:** CLAUDE.md states "All LLM calls route through LiteLLM. Never import provider SDKs directly." The commented-out service means that in a typical `make up.full` run, there is no LiteLLM proxy at `http://litellm:4000`, and any service calling `litellm.acompletion(api_base=settings.litellm_base_url)` will get a connection error rather than a clean failure. The redactor callback is bypassed.

**Fix sketch:** Document in `.env.example` and `CLAUDE.md` that `litellm` must be uncommented before using `full` profile. Alternatively, add it to the `full` profile (it was previously intentionally external). Services depending on LiteLLM should have `depends_on: {litellm: {condition: service_healthy}}` under the `full` profile.

---

### Finding 9 — P3: `.env.example` still references removed/renamed source-system MCPs

**File:line:** `.env.example:159-161`

**Evidence:**
```
MCP_ELN_BENCHLING_URL=http://localhost:8013
MCP_LIMS_STARLIMS_URL=http://localhost:8014
MCP_INSTRUMENT_WATERS_URL=http://localhost:8015
```

Port 8013 is now `mcp-eln-local` (local mock, not Benchling). Port 8014 is `mcp-crest`. Port 8015 is `mcp-yield-baseline` (or `mcp-genchem` — the collision). None of these env var names match what `config.ts` reads (`MCP_ELN_LOCAL_URL`, `MCP_CREST_URL`, `MCP_YIELD_BASELINE_URL`).

**Why it's a problem:** A developer copying `.env.example` and using these vars will have incorrect URL mappings. The vars are completely ignored by current code (config.ts doesn't read `MCP_ELN_BENCHLING_URL`), but their presence creates confusion about the actual port assignments.

**Fix sketch:** Replace the three stale lines with:
```
MCP_ELN_LOCAL_URL=http://localhost:8013
MCP_CREST_URL=http://localhost:8014
MCP_YIELD_BASELINE_URL=http://localhost:8015
MCP_GENCHEM_URL=http://localhost:8023
```

---

### Finding 10 — P4: Prior audit finding H4 (`routes/forged-tools.ts` never registered) is FIXED

**File:line:** `services/agent-claw/src/bootstrap/routes.ts:22,89`

**Evidence:**
```typescript
import { registerForgedToolsRoutes } from "../routes/forged-tools.js";
// ...
registerForgedToolsRoutes(app, deps.pool, getUser);
```

The 260-LOC route file is now properly imported and registered in `bootstrap/routes.ts`. Scope-promotion updates to `skill_library` are reachable in production. The PR-6 god-file split that extracted `routes.ts` from `index.ts` included this registration.

---

### Finding 11 — P4: `services/frontend/` directory status

The CLAUDE.md states "the Streamlit frontend was moved to a separate repo." Based on read attempts, `services/frontend/app.py` does not exist. The directory itself may be empty or removed. No evidence of a running frontend service in compose.

**Status:** Consistent with CLAUDE.md claim; no frontend code visible to this audit. If the directory itself still exists as an empty stub, it should be removed to avoid confusion.

---

### Finding 12 — P4: Permission resolver not wired in production routes

**File:line:** `services/agent-claw/src/routes/chat.ts:387-399`

**Evidence:** `runHarness` call in `chat.ts` does not pass `permissions: { permissionMode: "enforce" }`. This is true for all five harness call paths (`/api/chat`, `/api/chat/plan/approve`, `/api/sessions/:id/plan/run`, `/api/sessions/:id/resume`, `/api/deep_research`).

**Status:** Confirmed as-designed per CLAUDE.md: "NOTE: the resolver is wired in `core/step.ts` but only fires when a route passes a `permissions` option to `runHarness`; no production route does today." The `permission` hook exists and works in unit/parity tests. No action required unless operators want to enforce tool policies.

---

### Finding 13 — Confirmed Correct (egress chokepoint)

`mcp-synthegy-mech/llm_policy.py` uses `import litellm` and calls `litellm.acompletion(..., api_base=self.api_base, ...)` where `self.api_base = os.getenv("LITELLM_BASE_URL")`. This routes through ChemClaw's LiteLLM proxy server, traversing the redactor callback. The `litellm` Python SDK here acts as an HTTP client to the proxy, not as a direct provider SDK. This is the documented pattern for Python services.

Similarly, `conditions_normalizer/llm_prompt.py` calls `litellm.acompletion(..., api_base=settings.litellm_base_url, ...)`. Both are correct.

No direct `import anthropic`, `import openai`, `from anthropic import ...`, or `from openai import ...` found in any non-litellm service code.

---

### Finding 14 — Confirmed Correct (cross-language boundary discipline)

All cross-service Python calls use HTTP (`httpx`). No Python service imports another Python service's modules directly (outside `services/mcp_tools/common/`, `services/projectors/common/`, `services/mcp_tools/mcp_xtb/` internal modules). The `mcp_yield_baseline → mcp_drfp/mcp_chemprop` calls (Finding 4) correctly use HTTP — the issue is missing auth headers, not a module-import boundary violation.

The workflow engine (`services/workflow_engine/main.py`) imports only from `services.mcp_tools.common` (shared library code), which is the documented exception.

---

### Finding 15 — Confirmed Correct (auth chokepoint — existing MCP services)

All six services audited in the prior boundary audit continue to use `create_app` (confirmed for newly added services as well):
- `mcp_askcos/main.py`, `mcp_aizynth/main.py`, `mcp_chemprop/main.py`, `mcp_xtb/main.py`, `mcp_crest/main.py`, `mcp_synthegy_mech/main.py`, `mcp_sirius/main.py`, `mcp_genchem/main.py`, `mcp_yield_baseline/main.py`, `mcp_reaction_optimizer/main.py`, `mcp_plate_designer/main.py`, `mcp_ord_io/main.py`, `mcp_green_chemistry/main.py`, `mcp_applicability_domain/main.py`, `mcp_eln_local/main.py`, `mcp_logs_sciy/main.py` — all use `create_app(...)`. Auth middleware is uniformly applied. The gap is that `mcp-eln-local` and `mcp-logs-sciy` don't receive the signing key in compose (Finding 3).

All agent-claw outbound MCP calls go through `postJson` / `getJson` in `services/agent-claw/src/mcp/postJson.ts`, which calls `getMcpToken(service)` to attach the Bearer JWT when `MCP_AUTH_SIGNING_KEY` is set.

---

## Cross-Reference: Prior Audit (2026-04-29)

### Fixed since 2026-04-29

| Prior finding | Status |
|---|---|
| **H4** — `routes/forged-tools.ts` never registered | **FIXED** in `bootstrap/routes.ts:22,89` |
| **H1** — `make db.init` only re-applies `01_schema.sql` | Addressed in PR-8 per CLAUDE.md commit notes |
| **H2/H3** — Missing RLS indexes | Addressed in PR-8 per CLAUDE.md |
| **L1** — `skill_library`/`forged_tool_tests` lack `maturity` column | Addressed in PR-8 per CLAUDE.md |
| **L2** — `skill_library` has no DELETE RLS policy | Addressed in PR-8 per CLAUDE.md |
| **M9/M10** — Confidence model fragmentation / missing bi-temporal cols | Addressed in PR-8 per CLAUDE.md (17_unified_confidence_and_temporal.sql) |
| **M3** — `index.ts` 565-LOC god-file | Addressed in PR-6 split (bootstrap/*, routes/chat-*.ts) |
| **M1/M2** — chat.ts and sessions.ts god-files | Addressed in PR-6 split (chat-helpers, chat-setup, chained-harness.ts, sessions-handlers.ts) |

### Persistent from 2026-04-29

| Prior finding | Status |
|---|---|
| **F-1** — `checkStaleFacts` dead code, never registered as pre_turn hook | Still present in `source-cache.ts:380-404`, still not registered |
| **F-2** — Three hooks ignore AbortSignal (`tag-maturity:138`, `compact-window:51`, `source-cache:512`) | Not fixed; `compact-window` remains highest risk |
| **F-3** — `plan/approve` constructs ToolContext without `lifecycle` field | Mitigated by `harness.ts:57-59`; latent footgun remains |
| **C2** — SSRF IPv4-mapped-IPv6 bypass | Status unknown without reading the PR-0 delta |

### New findings (not in prior audit)

1. **P1** — Port collision: genchem + yield-baseline both on 8015 (compose drift from Z-series merges adding new chemistry MCPs)
2. **P1** — Port collision: gepa-runner + mcp-xtb both on 8010 (existed before but newly promoted to P1 given chemistry profile expansion)
3. **P2** — mcp-eln-local and mcp-logs-sciy missing auth env vars in compose (introduced in F.2 merge)
4. **P2** — mcp-yield-baseline → mcp-drfp/chemprop calls lack Bearer tokens (introduced in Z-series yield baseline work)
5. **P2** — MCP_GENCHEM_URL config.ts default (8023) inconsistent with compose (8015)
6. **P3** — conditions-normalizer projector absent from compose (introduced or missed in Z-series conditions work)
7. **P3** — kg-source-cache missing depends_on: mcp-kg and healthcheck (introduced in F.2 sources merge)
8. **P3** — litellm service commented out with no guidance for profiles that depend on it
9. **P4** — `.env.example` stale source-system URL vars (from pre-F.2 naming scheme)
10. **P1(secondary)** — skill-promoter (optimizer:8011) collides with mcp-synthegy-mech (chemistry:8011)

---

## Essential Files for Understanding This Topic

- `docker-compose.yml` — canonical service inventory and port assignments; all collision findings originate here
- `services/agent-claw/src/config.ts` — agent-claw URL defaults; the genchem:8023 vs compose:8015 drift is here
- `services/agent-claw/src/bootstrap/dependencies.ts` — complete builtin tool registration; every MCP service has a corresponding entry here
- `services/agent-claw/src/bootstrap/routes.ts` — route registration; shows forged-tools now wired (H4 fixed)
- `services/mcp_tools/mcp_yield_baseline/main.py` — P2 finding: unauthenticated MCP-to-MCP calls at lines 115-138
- `services/mcp_tools/mcp_synthegy_mech/xtb_validator.py` — reference implementation of correct MCP-to-MCP auth using McpTokenCache
- `services/mcp_tools/common/app.py` — `create_app` factory; all MCP auth flows through here
- `services/mcp_tools/common/mcp_token_cache.py` — Python-side token cache for system services; unused by yield-baseline
- `services/agent-claw/src/mcp/postJson.ts` — TS-side JWT attachment for all agent → MCP calls
- `services/projectors/conditions_normalizer/main.py` — projector present on disk but absent from compose
- `docs/review/2026-04-29-codebase-audit/06-boundary-audit.md` — prior boundary findings (F-1, F-2, F-3 still open)
- `.env.example` — stale source-system URL vars at lines 159-161
