# wiki_regen — knowledge-wiki body-synthesis daemon (ADR 012 Phase 2b).
# Polls knowledge_articles for `dirty` entity-backed pages, gathers context
# from Postgres, asks the `wiki.synthesis` prompt (via central LiteLLM) to
# write a cited Markdown body, records citations + a revision row, preserves
# human:* blocks. Connects as chemclaw_service (BYPASSRLS).

FROM python:3.11-slim AS base

# OpenShift SCC compat — non-root UID.
RUN groupadd -r -g 1001 chemclaw && useradd -r -u 1001 -g chemclaw chemclaw

WORKDIR /app

COPY services/_constraints.txt /app/services/_constraints.txt
COPY services/optimizer/wiki_regen/requirements.txt /app/services/optimizer/wiki_regen/requirements.txt
RUN pip install --no-cache-dir -r /app/services/optimizer/wiki_regen/requirements.txt

# The daemon imports configure_logging from the shared mcp_tools.common pkg.
COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/optimizer/__init__.py /app/services/optimizer/__init__.py
COPY services/optimizer/wiki_regen/ /app/services/optimizer/wiki_regen/

ENV PYTHONPATH=/app PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 LOG_LEVEL=INFO

USER 1001:1001

ENTRYPOINT ["python3", "-m", "services.optimizer.wiki_regen.main"]
