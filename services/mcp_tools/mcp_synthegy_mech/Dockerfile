FROM python:3.11-slim

WORKDIR /app

# rdkit-pypi wheels embed their native deps, so no apt-get installs needed.
COPY services/mcp_tools/mcp_synthegy_mech/requirements.txt /app/services/mcp_tools/mcp_synthegy_mech/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_synthegy_mech/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_synthegy_mech /app/services/mcp_tools/mcp_synthegy_mech

ENV PYTHONPATH=/app
EXPOSE 8011

# OpenShift SCC requires UID >= 1000 and not 0.
RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_synthegy_mech.main:app", \
     "--host", "0.0.0.0", "--port", "8011"]
