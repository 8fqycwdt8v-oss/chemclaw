FROM python:3.11-slim
WORKDIR /app

COPY services/mcp_tools/mcp_instrument_waters/requirements.txt /app/services/mcp_tools/mcp_instrument_waters/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_instrument_waters/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_instrument_waters /app/services/mcp_tools/mcp_instrument_waters

ENV PYTHONPATH=/app
EXPOSE 8015

# Non-root for OpenShift SCC compatibility.
RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_instrument_waters.main:app", \
     "--host", "0.0.0.0", "--port", "8015"]
