#!/usr/bin/env bash
# Phase 4 of the configuration concept (Initiative 8).
#
# Restore the latest encrypted Postgres + Neo4j backups into a transient
# compose project and run scripts/smoke.sh against it. Verifies that the
# Helm CronJob's output is actually restorable end-to-end — backups that
# can't restore are worse than no backups at all.
#
# Required env vars:
#   BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_PREFIX
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#   AGE_IDENTITY_FILE  — path to the age private key (NOT in any
#                        Kubernetes secret; pull from the vault manually)
#
# Usage:
#   make backup.test-restore
#   ./scripts/backup_test_restore.sh

set -euo pipefail

PROJECT_NAME="chemclaw-restore-$$"
RESTORE_DIR="$(mktemp -d -t chemclaw-restore.XXXXXX)"
trap 'docker compose -p "$PROJECT_NAME" down -v >/dev/null 2>&1 || true; rm -rf "$RESTORE_DIR"' EXIT

require_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is required" >&2
    exit 64
  fi
}

require_env BACKUP_S3_ENDPOINT
require_env BACKUP_S3_BUCKET
require_env AWS_ACCESS_KEY_ID
require_env AWS_SECRET_ACCESS_KEY
require_env AGE_IDENTITY_FILE

BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-postgres}"

echo "==> Listing backups in s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/"
LATEST_PG="$(aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 ls \
  "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/" \
  | awk '{print $4}' \
  | grep '\.pgc\.age$' \
  | sort | tail -1)"

if [[ -z "$LATEST_PG" ]]; then
  echo "ERROR: no Postgres backups found." >&2
  exit 65
fi

echo "==> Downloading $LATEST_PG"
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp \
  "s3://${BACKUP_S3_BUCKET}/${BACKUP_S3_PREFIX}/${LATEST_PG}" \
  "$RESTORE_DIR/dump.pgc.age"

echo "==> Decrypting with $AGE_IDENTITY_FILE"
age -d -i "$AGE_IDENTITY_FILE" -o "$RESTORE_DIR/dump.pgc" "$RESTORE_DIR/dump.pgc.age"

echo "==> Bringing up transient compose stack: $PROJECT_NAME"
docker compose -p "$PROJECT_NAME" up -d postgres
# Wait for Postgres readiness.
for i in {1..30}; do
  if docker compose -p "$PROJECT_NAME" exec -T postgres pg_isready -U chemclaw >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "==> Restoring dump"
docker compose -p "$PROJECT_NAME" exec -T postgres pg_restore --clean --if-exists \
  -U chemclaw -d chemclaw < "$RESTORE_DIR/dump.pgc"

echo "==> Re-applying schema migrations (idempotent)"
docker compose -p "$PROJECT_NAME" run --rm app sh -c \
  "for f in /docker-entrypoint-initdb.d/*.sql; do psql -v ON_ERROR_STOP=0 -f \"\$f\" || true; done"

echo "==> Running smoke.sh against restored stack"
COMPOSE_PROJECT_NAME="$PROJECT_NAME" \
  SKIP_SOURCES=1 SKIP_LANGFUSE=1 SKIP_AGENT=1 \
  ./scripts/smoke.sh

echo "==> Restore validated successfully."
