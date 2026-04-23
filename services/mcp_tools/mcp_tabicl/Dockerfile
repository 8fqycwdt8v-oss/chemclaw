FROM python:3.11-slim
RUN groupadd -g 1001 app && useradd -r -u 1001 -g app app
WORKDIR /app
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/mcp_tabicl /app/services/mcp_tools/mcp_tabicl
COPY services/__init__.py /app/services/__init__.py
RUN pip install --no-cache-dir -r services/mcp_tools/mcp_tabicl/requirements.txt
RUN mkdir -p /var/cache/mcp-tabicl && chown -R app:app /var/cache/mcp-tabicl /app
USER 1001:1001
EXPOSE 8005
CMD ["uvicorn", "services.mcp_tools.mcp_tabicl.main:app", "--host", "0.0.0.0", "--port", "8005"]
