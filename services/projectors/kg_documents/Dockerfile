FROM python:3.11-slim
RUN groupadd -g 1001 app && useradd -r -u 1001 -g app app
WORKDIR /app
COPY services/projectors/common /app/services/projectors/common
COPY services/projectors/__init__.py /app/services/projectors/__init__.py
COPY services/__init__.py /app/services/__init__.py
COPY services/projectors/kg_documents /app/services/projectors/kg_documents
RUN pip install --no-cache-dir -r services/projectors/kg_documents/requirements.txt
USER 1001:1001
CMD ["python", "-m", "services.projectors.kg_documents.main"]
