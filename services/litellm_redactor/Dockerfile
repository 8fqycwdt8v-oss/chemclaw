# The redactor module is consumed BY the LiteLLM process (not a standalone
# service). We package it as a sidecar image that LiteLLM mounts the
# python package from — OR we bake the redactor directly into a custom
# LiteLLM image. This Dockerfile extends the LiteLLM image with our
# redactor package available on PYTHONPATH.

FROM ghcr.io/berriai/litellm:main-v1.60.0
WORKDIR /app

COPY services/__init__.py /app/services/__init__.py
COPY services/litellm_redactor /app/services/litellm_redactor
COPY services/litellm/config.yaml /app/config.yaml

RUN pip install --no-cache-dir -r /app/services/litellm_redactor/requirements.txt

ENV PYTHONPATH=/app
EXPOSE 4000

CMD ["--config", "/app/config.yaml", "--port", "4000"]
