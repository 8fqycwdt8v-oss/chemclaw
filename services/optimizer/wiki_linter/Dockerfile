# wiki_linter — periodic deterministic sweep of the knowledge wiki (ADR 012 Phase 4a).
# Creates missing project-page stubs, logs orphans, rebuilds the `index` page.
# Pure Postgres, no LLM. Connects as chemclaw_service (BYPASSRLS).

FROM python:3.11-slim AS base

RUN groupadd -r -g 1001 chemclaw && useradd -r -u 1001 -g chemclaw chemclaw

WORKDIR /app

COPY services/_constraints.txt /app/services/_constraints.txt
COPY services/optimizer/wiki_linter/requirements.txt /app/services/optimizer/wiki_linter/requirements.txt
RUN pip install --no-cache-dir -r /app/services/optimizer/wiki_linter/requirements.txt

# configure_logging lives in the shared mcp_tools.common pkg.
COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/optimizer/__init__.py /app/services/optimizer/__init__.py
COPY services/optimizer/wiki_linter/ /app/services/optimizer/wiki_linter/

ENV PYTHONPATH=/app PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 LOG_LEVEL=INFO

USER 1001:1001

ENTRYPOINT ["python3", "-m", "services.optimizer.wiki_linter.main"]
