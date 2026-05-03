-- Phase 6 — Postgres-backed batch / queue.
--
-- Single broker-free queue keyed by `task_kind` for chemistry sweeps. The
-- worker (services/queue/) leases jobs via SELECT ... FOR UPDATE SKIP LOCKED
-- so multiple replicas don't double-execute. Re-enqueuing the same payload
-- (same idempotency_key for the same task_kind) is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS task_queue (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_kind          TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority           INTEGER NOT NULL DEFAULT 100,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'leased', 'succeeded', 'failed', 'cancelled')),
  leased_by          TEXT,
  lease_expires_at   TIMESTAMPTZ,
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_attempts       INTEGER NOT NULL DEFAULT 3,
  batch_id           UUID,
  parent_task_id     UUID REFERENCES task_queue(id) ON DELETE SET NULL,
  idempotency_key    BYTEA,
  error              JSONB,
  result             JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_task_queue_idempotency
  ON task_queue (task_kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_task_queue_pending
  ON task_queue (task_kind, priority DESC, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_task_queue_leased_expired
  ON task_queue (lease_expires_at)
  WHERE status = 'leased';

CREATE INDEX IF NOT EXISTS idx_task_queue_batch
  ON task_queue (batch_id) WHERE batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_batches (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT,
  kind          TEXT,
  total         INTEGER NOT NULL DEFAULT 0,
  succeeded     INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  cancelled     INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_task_batches_created
  ON task_batches (created_at DESC);

-- NOTIFY hooks
CREATE OR REPLACE FUNCTION notify_task_queue_pending() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM pg_notify('task_queue_pending', NEW.task_kind);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_task_queue_pending ON task_queue;
CREATE TRIGGER trg_notify_task_queue_pending
  AFTER INSERT ON task_queue
  FOR EACH ROW EXECUTE FUNCTION notify_task_queue_pending();

CREATE OR REPLACE FUNCTION notify_task_finished() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('succeeded', 'failed', 'cancelled')
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('succeeded', 'failed', 'cancelled')) THEN
    PERFORM pg_notify('task_finished', NEW.id::text);
    -- Also bump batch counters when applicable.
    IF NEW.batch_id IS NOT NULL THEN
      UPDATE task_batches b
         SET succeeded = succeeded + (CASE WHEN NEW.status = 'succeeded' THEN 1 ELSE 0 END),
             failed    = failed    + (CASE WHEN NEW.status = 'failed'    THEN 1 ELSE 0 END),
             cancelled = cancelled + (CASE WHEN NEW.status = 'cancelled' THEN 1 ELSE 0 END),
             finished_at = CASE
               WHEN succeeded + (CASE WHEN NEW.status = 'succeeded' THEN 1 ELSE 0 END)
                  + failed    + (CASE WHEN NEW.status = 'failed'    THEN 1 ELSE 0 END)
                  + cancelled + (CASE WHEN NEW.status = 'cancelled' THEN 1 ELSE 0 END)
                  >= total
                 THEN NOW()
                 ELSE finished_at
             END
       WHERE id = NEW.batch_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_task_finished ON task_queue;
CREATE TRIGGER trg_notify_task_finished
  AFTER INSERT OR UPDATE OF status ON task_queue
  FOR EACH ROW EXECUTE FUNCTION notify_task_finished();

-- RLS / grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT, INSERT ON task_queue, task_batches TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON task_queue, task_batches TO chemclaw_service;
  END IF;
END $$;

-- Permission policies
INSERT INTO permission_policies (scope, scope_id, decision, tool_pattern, reason, created_by)
  VALUES
    ('global', '', 'allow', 'enqueue_batch', 'Batch enqueue is read-additive; auto-allow with audit trail.', '__system__'),
    ('global', '', 'allow', 'inspect_batch', 'Read-only; auto-allow.', '__system__')
  ON CONFLICT DO NOTHING;

INSERT INTO schema_version (filename, applied_at)
  VALUES ('27_job_queue.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
