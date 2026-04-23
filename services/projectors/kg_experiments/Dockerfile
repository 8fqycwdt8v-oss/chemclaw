FROM python:3.11-slim
WORKDIR /app

COPY services/projectors/kg_experiments/requirements.txt /app/services/projectors/kg_experiments/requirements.txt
RUN pip install --no-cache-dir -r /app/services/projectors/kg_experiments/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/projectors /app/services/projectors

ENV PYTHONPATH=/app

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "services.projectors.kg_experiments.main"]
