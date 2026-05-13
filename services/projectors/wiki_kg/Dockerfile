FROM python:3.11-slim
RUN groupadd -g 1001 app && useradd -r -u 1001 -g app app
WORKDIR /app

COPY services/projectors/wiki_kg/requirements.txt /app/services/projectors/wiki_kg/requirements.txt
RUN pip install --no-cache-dir -r /app/services/projectors/wiki_kg/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/projectors/__init__.py /app/services/projectors/__init__.py
COPY services/projectors/common /app/services/projectors/common
COPY services/projectors/wiki_kg /app/services/projectors/wiki_kg

ENV PYTHONPATH=/app
USER 1001:1001
CMD ["python", "-m", "services.projectors.wiki_kg.main"]
