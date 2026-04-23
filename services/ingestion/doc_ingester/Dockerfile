FROM python:3.11-slim
WORKDIR /app

COPY services/ingestion/doc_ingester/requirements.txt /app/services/ingestion/doc_ingester/requirements.txt
RUN pip install --no-cache-dir -r /app/services/ingestion/doc_ingester/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/ingestion/__init__.py /app/services/ingestion/__init__.py
COPY services/ingestion/doc_ingester /app/services/ingestion/doc_ingester

ENV PYTHONPATH=/app

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "services.ingestion.doc_ingester.cli", "scan"]
