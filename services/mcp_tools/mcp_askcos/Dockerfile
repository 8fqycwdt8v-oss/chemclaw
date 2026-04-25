FROM python:3.11-slim
WORKDIR /app

# ASKCOS v2 depends on rdkit + torch; install system headers first.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libxrender1 libxext6 build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY services/mcp_tools/mcp_askcos/requirements.txt /app/services/mcp_tools/mcp_askcos/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_askcos/requirements.txt

# Install ASKCOS v2 from the official wheel (set ASKCOS_WHL_URL as build-arg).
ARG ASKCOS_WHL_URL=""
RUN if [ -n "$ASKCOS_WHL_URL" ]; then pip install --no-cache-dir "$ASKCOS_WHL_URL"; fi

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_askcos /app/services/mcp_tools/mcp_askcos

ENV PYTHONPATH=/app
EXPOSE 8007

# Non-root for OpenShift SCC compatibility.
RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_askcos.main:app", \
     "--host", "0.0.0.0", "--port", "8007"]
