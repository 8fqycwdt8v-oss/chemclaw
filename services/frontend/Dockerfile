FROM python:3.11-slim
WORKDIR /app

# System deps for psycopg (no system libpq needed with binary wheels)
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
  && rm -rf /var/lib/apt/lists/*

COPY services/frontend/requirements.txt /app/services/frontend/requirements.txt
RUN pip install --no-cache-dir -r /app/services/frontend/requirements.txt

COPY services/frontend /app/services/frontend
COPY services/__init__.py /app/services/__init__.py

ENV PYTHONPATH=/app
EXPOSE 8501
CMD ["streamlit", "run", "services/frontend/streamlit_app.py", \
     "--server.address=0.0.0.0", "--server.port=8501"]
