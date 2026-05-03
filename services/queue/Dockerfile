FROM python:3.11-slim
WORKDIR /app

COPY services/queue/requirements.txt /app/services/queue/requirements.txt
RUN pip install --no-cache-dir -r /app/services/queue/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/queue /app/services/queue

ENV PYTHONPATH=/app

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "services.queue.worker"]
