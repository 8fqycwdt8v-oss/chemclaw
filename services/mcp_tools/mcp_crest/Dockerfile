FROM python:3.11-slim

# CREST + xtb required at runtime. Image inherits the conda layer pattern from
# mcp-xtb's Dockerfile; for greenfield builds use the upstream xtb-tblite
# binary releases. The conda channel is the most tractable cross-platform
# install.
RUN apt-get update && apt-get install -y --no-install-recommends \
      wget bzip2 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Conda micromamba — small footprint, fast install.
ARG MAMBA_VERSION=2.0.5
RUN wget -qO- "https://github.com/mamba-org/micromamba-releases/releases/download/${MAMBA_VERSION}-0/micromamba-linux-64.tar.bz2" \
      | tar -xvjf - bin/micromamba \
    && mv bin/micromamba /usr/local/bin/ \
    && rmdir bin

ENV MAMBA_ROOT_PREFIX=/opt/micromamba
RUN micromamba create -y -n chem -c conda-forge xtb crest && micromamba clean --all -y

ENV PATH=/opt/micromamba/envs/chem/bin:$PATH

WORKDIR /app

COPY services/mcp_tools/mcp_crest/requirements.txt /app/services/mcp_tools/mcp_crest/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_crest/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_crest /app/services/mcp_tools/mcp_crest

ENV PYTHONPATH=/app
ENV MCP_TOOL_HOST=0.0.0.0
ENV MCP_TOOL_PORT=8014

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

EXPOSE 8014
CMD ["python", "-m", "services.mcp_tools.mcp_crest.main"]
