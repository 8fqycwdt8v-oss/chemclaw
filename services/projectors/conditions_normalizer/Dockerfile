FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY services/projectors/conditions_normalizer/requirements.txt /app/services/projectors/conditions_normalizer/requirements.txt
RUN pip install --no-cache-dir -r /app/services/projectors/conditions_normalizer/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/projectors/__init__.py /app/services/projectors/__init__.py
COPY services/projectors/common /app/services/projectors/common
COPY services/projectors/conditions_normalizer /app/services/projectors/conditions_normalizer

ENV PYTHONPATH=/app

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "services.projectors.conditions_normalizer.main"]
