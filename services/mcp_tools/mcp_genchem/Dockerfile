FROM python:3.11-slim
WORKDIR /app

COPY services/mcp_tools/mcp_genchem/requirements.txt /app/services/mcp_tools/mcp_genchem/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_genchem/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_genchem /app/services/mcp_tools/mcp_genchem

ENV PYTHONPATH=/app
ENV MCP_TOOL_HOST=0.0.0.0
ENV MCP_TOOL_PORT=8015

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

EXPOSE 8015
CMD ["python", "-m", "services.mcp_tools.mcp_genchem.main"]
