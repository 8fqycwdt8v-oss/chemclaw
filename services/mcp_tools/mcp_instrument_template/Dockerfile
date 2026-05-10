# Template Dockerfile — copy alongside the directory and replace
# every occurrence of "mcp_instrument_template" with the vendor name.
# The skeleton image runs but every content endpoint returns 501; it
# exists so `docker build` and the OpenShift SCC user remap (UID 1001)
# can be sanity-checked before real vendor calls land.
FROM python:3.11-slim
WORKDIR /app

COPY services/mcp_tools/mcp_instrument_template/requirements.txt /app/services/mcp_tools/mcp_instrument_template/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_instrument_template/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_instrument_template /app/services/mcp_tools/mcp_instrument_template

ENV PYTHONPATH=/app
EXPOSE 8013

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_instrument_template.main:app", \
     "--host", "0.0.0.0", "--port", "8013"]
