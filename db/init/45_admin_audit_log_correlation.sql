-- Cluster B: admin_audit_log gains nullable request_id + trace_id
-- columns so audit entries can be pivoted to Loki / Langfuse.
--
-- Pre-fix the table carried only {occurred_at, actor, action, target,
-- before_value, after_value, reason}. An alert that fired on
-- "config.set on PROD secret bucket" couldn't be linked to the originating
-- HTTP request without time-window grep against Loki — Pino + Loki
-- already carry req.id via logContextFields(), and Fastify generates
-- req.id for every admin call, so the data exists, just doesn't reach
-- the audit row.
--
-- Both columns are nullable so the migration is additive and pre-existing
-- rows aren't touched. The TS-side appendAudit() helper reads
-- request_id from the AsyncLocalStorage RequestContext and trace_id
-- from the active OTel span.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'admin_audit_log' AND column_name = 'request_id'
  ) THEN
    ALTER TABLE admin_audit_log ADD COLUMN request_id TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'admin_audit_log' AND column_name = 'trace_id'
  ) THEN
    ALTER TABLE admin_audit_log ADD COLUMN trace_id TEXT;
  END IF;
END
$$;

-- B-tree on trace_id for fast lookup by Langfuse trace id during
-- post-mortem ("which audit rows came from this trace?").
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_trace_id
  ON admin_audit_log(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_request_id
  ON admin_audit_log(request_id) WHERE request_id IS NOT NULL;

COMMIT;
