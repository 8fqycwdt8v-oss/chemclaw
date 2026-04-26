# session_purger — TTL daemon evicting expired agent_sessions rows.
# Connects as chemclaw_service (BYPASSRLS) so it can DELETE across users.
# Cascade FKs clean up agent_todos + agent_plans.

FROM python:3.11-slim AS base

# OpenShift SCC compat — non-root UID.
RUN groupadd -r -g 1001 chemclaw && useradd -r -u 1001 -g chemclaw chemclaw

WORKDIR /app

# Install minimal deps via the per-service requirements file.
COPY services/_constraints.txt /app/services/_constraints.txt
COPY services/optimizer/session_purger/requirements.txt /app/services/optimizer/session_purger/requirements.txt
RUN pip install --no-cache-dir \
    -r /app/services/optimizer/session_purger/requirements.txt

COPY services/optimizer/session_purger/ /app/services/optimizer/session_purger/

USER 1001:1001

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LOG_LEVEL=INFO

# No HTTP server — daemon polls Postgres + DELETEs expired rows.
ENTRYPOINT ["python3", "-m", "services.optimizer.session_purger.main"]
