FROM python:3.11-slim
WORKDIR /app

COPY services/mcp_tools/mcp_eln_local/requirements.txt /app/services/mcp_tools/mcp_eln_local/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_eln_local/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_eln_local /app/services/mcp_tools/mcp_eln_local

ENV PYTHONPATH=/app
EXPOSE 8013

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_eln_local.main:app", \
     "--host", "0.0.0.0", "--port", "8013"]
