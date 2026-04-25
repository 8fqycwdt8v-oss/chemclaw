FROM python:3.11-slim

WORKDIR /app
RUN useradd -u 1001 -m appuser

COPY services/optimizer/gepa_runner/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY services/optimizer /app/services/optimizer
COPY services/__init__.py /app/services/__init__.py
COPY tests/golden /app/tests/golden

USER 1001

ENV GEPA_PORT=8010
EXPOSE 8010

CMD ["python", "-m", "services.optimizer.gepa_runner.runner"]
