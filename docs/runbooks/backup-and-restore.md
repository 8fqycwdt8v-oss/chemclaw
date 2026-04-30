# Runbook: Backup and disaster recovery

Phase 4 of the configuration concept added daily encrypted backups of
Postgres + Neo4j to S3-compatible storage. This runbook covers:

1. Initial setup (Helm)
2. Verifying backups are running
3. Restoring after an incident
4. Periodic restore-validation drills

## RPO / RTO targets

| Target | Value | Why |
|---|---|---|
| **RPO** (recovery point objective) | 24 hours | Backups run nightly; intra-day data loss bounded |
| **RTO** (recovery time objective) | 60 minutes | Restore is dump-driven, not block-snapshot |

If you need a tighter RPO, switch the schedule to `0 */6 * * *` (every
6h) and bump retention proportionally.

## 1. Setup

### Prerequisites

- S3-compatible storage with access keys (AWS S3, MinIO, R2, etc.).
- An `age` keypair (https://age-encryption.org). Generate locally:
  ```bash
  age-keygen -o backup-restore.key
  age-keygen -y backup-restore.key   # public recipient string
  ```
  Store the private key in a vault separate from cluster ops.

### Helm values

In `prod-values.yaml`:

```yaml
backups:
  enabled: true
  ageRecipient: "age1...your-public-key..."
  retentionDays: 30
  s3:
    endpoint: "https://s3.us-east-1.amazonaws.com"
    bucket: "acme-chemclaw-backups"
    prefix: "prod"
    credentialsSecret: chemclaw-backup-s3-credentials
  postgres:
    schedule: "0 1 * * *"
  neo4j:
    schedule: "30 1 * * *"
```

Create the secret:

```bash
kubectl create secret generic chemclaw-backup-s3-credentials \
  --from-literal=access_key_id=AKIA... \
  --from-literal=secret_access_key=...
```

`helm upgrade chemclaw ./infra/helm -f prod-values.yaml`.

## 2. Verify backups are running

```bash
kubectl get cronjobs -l profile=backups
kubectl get jobs --sort-by=.metadata.creationTimestamp -l app=postgres-backup | tail -5
kubectl logs job/postgres-backup-<timestamp>
```

Expect a final line `aws s3 cp ... s3://...` and exit code 0.

In S3:

```bash
aws s3 ls s3://acme-chemclaw-backups/prod/ --recursive
```

Newest object should be < 25h old; oldest should be ≤ `retentionDays + 1`
days old.

## 3. Restore after an incident

### Postgres

```bash
# Decrypt
aws s3 cp s3://acme-chemclaw-backups/prod/2026-04-30.pgc.age dump.pgc.age
age -d -i backup-restore.key -o dump.pgc dump.pgc.age

# Restore into a fresh DB
docker compose down -v   # destructive — only on the recovery host
docker compose up -d postgres
docker compose exec -T postgres pg_restore --clean --if-exists \
  -U chemclaw -d chemclaw < dump.pgc

# Re-apply migrations (idempotent — picks up schemas added since the dump)
make db.init
```

### Neo4j

```bash
aws s3 cp s3://acme-chemclaw-backups/prod/2026-04-30.backup.age neo4j.backup.age
age -d -i backup-restore.key -o neo4j.backup neo4j.backup.age

docker compose stop neo4j
docker compose run --rm -v "$(pwd):/restore" neo4j \
  neo4j-admin database load --from-path=/restore neo4j --overwrite-destination=true
docker compose start neo4j
```

### Replay projectors

After restore, the projection_acks table mirrors the dump. To rebuild
derived KG views from scratch:

```sql
DELETE FROM projection_acks WHERE projector_name IN (
  'kg_hypotheses', 'kg_source_cache', 'contextual_chunker',
  'reaction_vectorizer', 'chunk_embedder', 'kg_experiments'
);
```

Restart projectors. They re-process the entire `ingestion_events` log.

### Smoke

```bash
make smoke
```

If smoke passes, mark the incident closed and announce restore.

## 4. Periodic restore drill

Backups that haven't been restore-tested are unproven. Run monthly:

```bash
export BACKUP_S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
export BACKUP_S3_BUCKET=acme-chemclaw-backups
export BACKUP_S3_PREFIX=prod
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AGE_IDENTITY_FILE=/secure/path/backup-restore.key

make backup.test-restore
```

The script downloads the latest backup, decrypts, restores into a
transient compose project, and runs smoke. Expected runtime ~5 minutes.

If it fails, the backup pipeline is broken — investigate before you need
it for real.

## Audit

Every restore should append a row to your team's incident log:

| Date | Backup taken | Restore RTO | Smoke passed | Initiator |
|---|---|---|---|---|
