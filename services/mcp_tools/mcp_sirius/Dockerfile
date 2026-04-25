FROM eclipse-temurin:21-jre-jammy AS jre

FROM python:3.11-slim
WORKDIR /app

# Java runtime for SIRIUS 6.
COPY --from=jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="$JAVA_HOME/bin:$PATH"

# Install SIRIUS 6 binary (set SIRIUS_VERSION as build-arg).
ARG SIRIUS_VERSION="6.0.7"
RUN apt-get update && apt-get install -y --no-install-recommends wget unzip \
  && wget -q "https://github.com/sirius-ms/sirius/releases/download/v${SIRIUS_VERSION}/sirius-${SIRIUS_VERSION}-linux-x64.zip" -O /tmp/sirius.zip \
  && unzip -q /tmp/sirius.zip -d /opt \
  && ln -s "/opt/sirius-${SIRIUS_VERSION}/bin/sirius" /usr/local/bin/sirius \
  && rm /tmp/sirius.zip \
  && apt-get remove -y wget unzip && rm -rf /var/lib/apt/lists/*

COPY services/mcp_tools/mcp_sirius/requirements.txt /app/services/mcp_tools/mcp_sirius/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_sirius/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_sirius /app/services/mcp_tools/mcp_sirius

ENV PYTHONPATH=/app
EXPOSE 8012

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_sirius.main:app", \
     "--host", "0.0.0.0", "--port", "8012"]
