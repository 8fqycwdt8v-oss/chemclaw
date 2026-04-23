FROM python:3.11-slim
WORKDIR /app

# Build deps for torch wheels on some arch combos; slim image is fine for CPU.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY services/mcp_tools/mcp_embedder/requirements.txt /app/services/mcp_tools/mcp_embedder/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_embedder/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_embedder /app/services/mcp_tools/mcp_embedder

ENV PYTHONPATH=/app
EXPOSE 8004

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

# Pre-download the model at build-time so cold starts are fast.
# (Commented by default — uncomment if you want a heavier but faster-to-start image.)
# RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-m3')"

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_embedder.main:app", \
     "--host", "0.0.0.0", "--port", "8004"]
