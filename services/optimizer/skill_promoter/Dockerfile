FROM python:3.11-slim

WORKDIR /app
RUN useradd -u 1001 -m appuser

COPY services/optimizer/skill_promoter/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY services/optimizer /app/services/optimizer
COPY services/__init__.py /app/services/__init__.py

USER 1001

ENV SKILL_PROMOTER_PORT=8011
EXPOSE 8011

CMD ["python", "-m", "services.optimizer.skill_promoter.runner"]
