# The redactor module is consumed BY the LiteLLM process (not a standalone
# service). We package it as a sidecar image that LiteLLM mounts the
# python package from — OR we bake the redactor directly into a custom
# LiteLLM image. This Dockerfile extends the LiteLLM image with our
# redactor package available on PYTHONPATH.
#
# Security: this base image MUST be pinned to a specific digest in
# production. The default tag below is for local development only. In
# production, override via:
#
#   docker build --build-arg LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm@sha256:<digest> ...
#
# Find the current digest with:
#   docker buildx imagetools inspect ghcr.io/berriai/litellm:main-v1.60.0
ARG LITELLM_BASE_IMAGE=ghcr.io/berriai/litellm:main-v1.60.0
FROM ${LITELLM_BASE_IMAGE}

WORKDIR /app

COPY services/__init__.py /app/services/__init__.py
COPY services/litellm_redactor /app/services/litellm_redactor
COPY services/litellm/config.yaml /app/config.yaml

RUN pip install --no-cache-dir -r /app/services/litellm_redactor/requirements.txt

# OpenShift SCC: run as a non-root UID. UID 1001 matches the convention used
# by every other Dockerfile in this repo (see services/mcp_tools/*/Dockerfile).
# We run useradd before chown so the final container has a real passwd entry
# for tooling that calls getpwuid().
RUN useradd -u 1001 -m -s /bin/bash litellm \
 && chown -R 1001:0 /app
USER 1001

ENV PYTHONPATH=/app
EXPOSE 4000

CMD ["--config", "/app/config.yaml", "--port", "4000"]
