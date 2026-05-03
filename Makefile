# ChemClaw — developer workflow entry points.
# Target a single goal per invocation; no multi-target chains.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------
VENV := .venv
PYTHON := python3
PIP := $(VENV)/bin/pip

# --------------------------------------------------------------------------
# Help
# --------------------------------------------------------------------------
.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_.-]+:.*?## / {printf "\033[36m%-28s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# --------------------------------------------------------------------------
# One-time setup
# --------------------------------------------------------------------------
.PHONY: setup
setup: setup.python setup.node ## One-time local setup (venv + node deps)

.PHONY: setup.python
setup.python: ## Create .venv and install Python deps for all services
	@test -d $(VENV) || $(PYTHON) -m venv $(VENV)
	$(PIP) install --upgrade pip
	$(PIP) install -e ".[dev]"
	$(PIP) install -e tools/cli
	$(PIP) install -r services/ingestion/eln_json_importer.legacy/requirements.txt
	$(PIP) install -r services/mcp_tools/mcp_rdkit/requirements.txt
	$(PIP) install -r services/mcp_tools/mcp_drfp/requirements.txt
	$(PIP) install -r services/mcp_tools/mcp_yield_baseline/requirements.txt
	$(PIP) install -r services/mcp_tools/mcp_plate_designer/requirements.txt
	$(PIP) install -r services/mcp_tools/mcp_ord_io/requirements.txt
	$(PIP) install -r services/mcp_tools/mcp_reaction_optimizer/requirements.txt
	$(PIP) install -r services/projectors/reaction_vectorizer/requirements.txt
	$(PIP) install -r services/projectors/chunk_embedder/requirements.txt
	$(PIP) install -r services/projectors/conditions_normalizer/requirements.txt
	$(PIP) install -r services/ingestion/doc_ingester/requirements.txt
	$(PIP) install -r services/litellm_redactor/requirements.txt
	$(PIP) install -r services/mock_eln/seed/requirements.txt
	@echo "Python env ready. Activate with: source $(VENV)/bin/activate"

.PHONY: setup.node
setup.node: ## Install Node dependencies for agent service
	npm install

# --------------------------------------------------------------------------
# Data layer (Docker Compose)
# --------------------------------------------------------------------------
.PHONY: up
up: ## Bring up Postgres + Neo4j + Langfuse
	docker compose up -d postgres neo4j

.PHONY: up.full
up.full: ## Bring up all data services (incl. Langfuse)
	docker compose up -d

.PHONY: up.chemistry
up.chemistry: ## Bring up chemistry MCP services (profile=chemistry; requires model checkpoints)
	docker compose --profile chemistry up -d

.PHONY: down
down: ## Stop all services (preserves volumes)
	docker compose down

.PHONY: nuke
nuke: ## Stop all services AND delete volumes (data loss)
	docker compose down -v

.PHONY: ps
ps: ## Show running services
	docker compose ps

.PHONY: logs
logs: ## Tail logs from all services
	docker compose logs -f --tail 100

# --------------------------------------------------------------------------
# Database
# --------------------------------------------------------------------------
.PHONY: db.psql
db.psql: ## Open psql shell into the app DB
	docker compose exec postgres psql -U chemclaw -d chemclaw

.PHONY: db.init
db.init: ## Re-apply schema (idempotent — applies all db/init/*.sql in lex order)
	@for f in db/init/*.sql; do \
	  echo "  applying $$f"; \
	  docker compose exec -T postgres psql -U chemclaw -d chemclaw \
	    -v ON_ERROR_STOP=1 < "$$f" || exit 1; \
	  docker compose exec -T postgres psql -U chemclaw -d chemclaw \
	    -c "INSERT INTO schema_version (filename) VALUES ('$$f') ON CONFLICT DO NOTHING" \
	    >/dev/null 2>&1 || true; \
	done
	@echo "  db.init complete"

.PHONY: db.seed
db.seed: ## Load sample seed data
	docker compose exec -T postgres psql -U chemclaw -d chemclaw < db/seed/01_sample_data.sql

.PHONY: seed.mock_eln
seed.mock_eln: ## Generate mock-ELN fixtures and load them into Postgres (gated by app.mock_eln_enabled)
	$(VENV)/bin/python -m services.mock_eln.seed.generator
	# Apply via host-side psql so \copy can read the local gzipped fixtures
	# from test-fixtures/mock_eln/world-default/. The compose postgres
	# service exposes 5432 on the host.
	PGPASSWORD=$${POSTGRES_PASSWORD:-chemclaw_dev_password_change_me} \
	psql -h $${POSTGRES_HOST:-localhost} -p $${POSTGRES_PORT:-5432} \
	     -U $${POSTGRES_USER:-chemclaw} -d $${POSTGRES_DB:-chemclaw} \
	     -v ON_ERROR_STOP=1 \
	     -c "SET app.mock_eln_enabled = 'on';" \
	     -f db/seed/20_mock_eln_data.sql

.PHONY: db.init.tabicl-pca
db.init.tabicl-pca: ## Cold-fit PCA model from all reactions in the database
	$(VENV)/bin/python scripts/tabicl_pca_coldfit.py --out $${MCP_TABICL_PCA_PATH:-/var/cache/mcp-tabicl/drfp_pca.json}

# --------------------------------------------------------------------------
# Services
# --------------------------------------------------------------------------
.PHONY: run.agent
run.agent: ## Run agent service in dev mode (hot-reload)
	npm run dev:agent

.PHONY: import.sample.legacy
import.sample.legacy: ## [DEPRECATED] One-shot bulk import via legacy eln_json_importer.
	@echo "WARNING: eln_json_importer is retired from the live path."
	@echo "Use this only for one-shot bulk migrations from a JSON dump."
	$(VENV)/bin/python -m services.ingestion.eln_json_importer.legacy.cli \
	  --input sample-data/eln-experiments-sample.json

.PHONY: run.mcp-rdkit
run.mcp-rdkit: ## Run mcp-rdkit locally (needs rdkit in .venv)
	$(VENV)/bin/python -m uvicorn services.mcp_tools.mcp_rdkit.main:app --host 0.0.0.0 --port 8001 --reload

.PHONY: run.mcp-drfp
run.mcp-drfp: ## Run mcp-drfp locally (needs drfp + rdkit in .venv)
	$(VENV)/bin/python -m uvicorn services.mcp_tools.mcp_drfp.main:app --host 0.0.0.0 --port 8002 --reload

.PHONY: run.mcp-tabicl
run.mcp-tabicl: ## Run mcp-tabicl locally
	$(VENV)/bin/python -m uvicorn services.mcp_tools.mcp_tabicl.main:app --host 0.0.0.0 --port 8005

.PHONY: run.reaction-vectorizer
run.reaction-vectorizer: ## Run the DRFP projector locally
	$(VENV)/bin/python -m services.projectors.reaction_vectorizer.main

.PHONY: run.chunk-embedder
run.chunk-embedder: ## Run the chunk-embedder projector locally
	$(VENV)/bin/python -m services.projectors.chunk_embedder.main

.PHONY: ingest.docs
ingest.docs: ## Scan sample-data/documents and ingest all supported files
	$(VENV)/bin/python -m services.ingestion.doc_ingester.cli scan

# --------------------------------------------------------------------------
# Quality
# --------------------------------------------------------------------------
.PHONY: lint
lint: ## Run all linters
	$(VENV)/bin/ruff check .
	npm run lint

.PHONY: format
format: ## Auto-format Python + TS
	$(VENV)/bin/ruff format .
	npm run format --if-present

.PHONY: typecheck
typecheck: ## Type-check Python + TS
	$(VENV)/bin/mypy services
	npm run typecheck

.PHONY: test
test: ## Run all tests
	$(VENV)/bin/pytest
	npm run test

.PHONY: coverage
coverage: ## Run TS + Python coverage and emit lcov / coverage.xml for diff-cover
	# TypeScript: vitest with @vitest/coverage-v8 (lcov + json-summary)
	npm run coverage --workspaces --if-present
	# Python: coverage.py over the same scope used by `make test`.
	# Emits coverage.xml (Cobertura) for diff-cover and a text summary.
	$(VENV)/bin/coverage erase
	-$(VENV)/bin/coverage run --rcfile=pyproject.toml -m pytest \
	  tests/unit/test_redactor.py \
	  tests/unit/optimizer/test_session_purger.py \
	  services/mcp_tools/common/tests/ \
	  services/projectors/kg_source_cache/tests/
	$(VENV)/bin/coverage combine || true
	$(VENV)/bin/coverage xml -o coverage.xml
	$(VENV)/bin/coverage report --skip-empty || true

.PHONY: diff-cover
diff-cover: coverage ## Enforce changed-line coverage thresholds against main
	# Thresholds per docs/review/2026-04-29-codebase-audit/05-coverage-baseline.md §8.
	# TypeScript (excluding routes, boot, config — carve-out at 60% below):
	$(VENV)/bin/diff-cover services/agent-claw/coverage/lcov.info \
	  --compare-branch=origin/main \
	  --fail-under=75 \
	  --fail-paths-not-found=false \
	  --exclude='services/agent-claw/src/routes/**' \
	  --exclude='services/agent-claw/src/index.ts' \
	  --exclude='services/agent-claw/src/config.ts'
	# TypeScript routes: 60% carve-out
	$(VENV)/bin/diff-cover services/agent-claw/coverage/lcov.info \
	  --compare-branch=origin/main \
	  --fail-under=60 \
	  --include='services/agent-claw/src/routes/**'
	# Python: 70% with NO-TESTS-services excluded (PR-N adds tests + removes excludes)
	$(VENV)/bin/diff-cover coverage.xml \
	  --compare-branch=origin/main \
	  --fail-under=70 \
	  --exclude='services/optimizer/session_reanimator/**' \
	  --exclude='services/projectors/kg_hypotheses/**' \
	  --exclude='services/mcp_tools/mcp_drfp/**' \
	  --exclude='services/mcp_tools/mcp_rdkit/**' \
	  --exclude='services/ingestion/eln_json_importer.legacy/**'

# --------------------------------------------------------------------------
# Smoke
# --------------------------------------------------------------------------
.PHONY: smoke
smoke: ## End-to-end smoke: up → init → seed → import → health-check
	@./scripts/smoke.sh

# --------------------------------------------------------------------------
# Backup verification (Phase 4 of the configuration concept)
# --------------------------------------------------------------------------
.PHONY: backup.test-restore
backup.test-restore: ## Restore the latest backup into a transient compose stack and run smoke against it.
	@./scripts/backup_test_restore.sh
