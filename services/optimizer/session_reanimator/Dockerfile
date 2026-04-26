# session_reanimator — auto-resume daemon for stalled agent sessions.
# Polls every 5 min and POSTs /api/sessions/:id/resume to the agent.
# Connects as chemclaw_service (BYPASSRLS) to read across users.

FROM python:3.11-slim AS base

# OpenShift SCC compat — non-root UID.
RUN groupadd -r -g 1001 chemclaw && useradd -r -u 1001 -g chemclaw chemclaw

WORKDIR /app

# Install minimal deps via the per-service requirements file. The constraints
# file at services/_constraints.txt pins shared lib versions across the fleet.
COPY services/_constraints.txt /app/services/_constraints.txt
COPY services/optimizer/session_reanimator/requirements.txt /app/services/optimizer/session_reanimator/requirements.txt
RUN pip install --no-cache-dir \
    -r /app/services/optimizer/session_reanimator/requirements.txt

COPY services/optimizer/session_reanimator/ /app/services/optimizer/session_reanimator/

# Run as non-root.
USER 1001:1001

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LOG_LEVEL=INFO

# No HTTP server — daemon polls Postgres + POSTs the agent.
ENTRYPOINT ["python3", "-m", "services.optimizer.session_reanimator.main"]
