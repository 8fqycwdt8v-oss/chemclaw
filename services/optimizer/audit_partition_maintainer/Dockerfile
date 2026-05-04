# audit_partition_maintainer — daily cron-like daemon that ensures the
# next N months of audit_log partitions exist before any write needs them.
# Connects as chemclaw_service (BYPASSRLS) for DDL access to audit_log.

FROM python:3.11-slim AS base

RUN groupadd -r -g 1001 chemclaw && useradd -r -u 1001 -g chemclaw chemclaw

WORKDIR /app

COPY services/_constraints.txt /app/services/_constraints.txt
COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/optimizer/__init__.py /app/services/optimizer/__init__.py
COPY services/optimizer/audit_partition_maintainer/requirements.txt \
     /app/services/optimizer/audit_partition_maintainer/requirements.txt
RUN pip install --no-cache-dir \
    -r /app/services/optimizer/audit_partition_maintainer/requirements.txt

COPY services/optimizer/audit_partition_maintainer/ \
     /app/services/optimizer/audit_partition_maintainer/

USER 1001:1001

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    LOG_LEVEL=INFO

ENTRYPOINT ["python3", "-m", "services.optimizer.audit_partition_maintainer.main"]
