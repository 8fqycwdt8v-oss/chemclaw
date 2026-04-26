FROM python:3.11-slim
WORKDIR /app

COPY services/mcp_tools/mcp_logs_sciy/requirements.txt /app/services/mcp_tools/mcp_logs_sciy/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_logs_sciy/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_logs_sciy /app/services/mcp_tools/mcp_logs_sciy

ENV PYTHONPATH=/app
EXPOSE 8016

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_logs_sciy.main:app", \
     "--host", "0.0.0.0", "--port", "8016"]
