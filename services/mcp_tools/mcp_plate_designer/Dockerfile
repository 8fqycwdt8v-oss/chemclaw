FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libxrender1 libxext6 \
  && rm -rf /var/lib/apt/lists/*

COPY services/mcp_tools/mcp_plate_designer/requirements.txt /app/services/mcp_tools/mcp_plate_designer/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_plate_designer/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_plate_designer /app/services/mcp_tools/mcp_plate_designer

ENV PYTHONPATH=/app
EXPOSE 8020

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_plate_designer.main:app", \
     "--host", "0.0.0.0", "--port", "8020"]
