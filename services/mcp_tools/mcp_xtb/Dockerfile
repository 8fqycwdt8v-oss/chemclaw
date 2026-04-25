FROM condaforge/mambaforge:latest AS build
# Install xTB + CREST via conda-forge (LGPL).
RUN mamba install -y -c conda-forge xtb crest && mamba clean -afy

FROM python:3.11-slim
WORKDIR /app

# Copy xTB/CREST binaries from the build stage.
COPY --from=build /opt/conda/bin/xtb /usr/local/bin/xtb
COPY --from=build /opt/conda/bin/crest /usr/local/bin/crest
COPY --from=build /opt/conda/lib /opt/conda/lib
ENV LD_LIBRARY_PATH=/opt/conda/lib

RUN apt-get update && apt-get install -y --no-install-recommends \
      libxrender1 libxext6 \
  && rm -rf /var/lib/apt/lists/*

COPY services/mcp_tools/mcp_xtb/requirements.txt /app/services/mcp_tools/mcp_xtb/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_xtb/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_xtb /app/services/mcp_tools/mcp_xtb

ENV PYTHONPATH=/app
EXPOSE 8010

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_xtb.main:app", \
     "--host", "0.0.0.0", "--port", "8010"]
