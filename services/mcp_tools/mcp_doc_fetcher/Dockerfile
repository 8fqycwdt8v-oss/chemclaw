FROM python:3.11-slim
WORKDIR /app

# poppler-utils is required by pdf2image for PDF-to-PNG rendering.
# Without it, the /pdf_pages endpoint falls back to pypdf text extraction
# with a warning — the container will still start and /fetch will work.
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils \
      curl \
  && rm -rf /var/lib/apt/lists/*

COPY services/mcp_tools/mcp_doc_fetcher/requirements.txt \
     /app/services/mcp_tools/mcp_doc_fetcher/requirements.txt
RUN pip install --no-cache-dir \
      -r /app/services/mcp_tools/mcp_doc_fetcher/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_doc_fetcher /app/services/mcp_tools/mcp_doc_fetcher

ENV PYTHONPATH=/app
EXPOSE 8006

# Non-root for OpenShift SCC compatibility.
RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_doc_fetcher.main:app", \
     "--host", "0.0.0.0", "--port", "8006"]
