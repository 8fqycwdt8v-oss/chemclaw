-- Paperclip-lite persistence schema.
-- Stores reservation history for crash recovery and per-day USD accounting.
-- The hot reservation state lives in the sidecar's in-process Map;
-- Postgres is the persistence layer for crash recovery only.

CREATE TABLE IF NOT EXISTS paperclip_state (
  reservation_id   UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_entra_id    TEXT        NOT NULL,
  session_id       TEXT        NOT NULL,
  est_tokens       INT         NOT NULL,
  est_usd          NUMERIC(10,6) NOT NULL,
  actual_tokens    INT,
  actual_usd       NUMERIC(10,6),
  status           TEXT        NOT NULL
                     CHECK (status IN ('reserved', 'released', 'expired'))
                     DEFAULT 'reserved',
  reserved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_paperclip_user_day
  ON paperclip_state (user_entra_id, reserved_at DESC);

CREATE INDEX IF NOT EXISTS idx_paperclip_status
  ON paperclip_state (status, reserved_at DESC);

-- RLS: users see only their own reservations.
--
-- Migration 16 (db_audit_fixes) idempotently DROP+CREATEs this policy with
-- the corrected shape; we keep the source-of-truth here in sync so a fresh
-- `db.init` doesn't briefly install the legacy fail-open form before 16
-- patches it. The empty-string fall-through (`current_setting = ''`) is
-- removed: production traffic always sets `app.current_user_entra_id` via
-- `withUserContext`, and `chemclaw_service` (BYPASSRLS) covers system
-- workers — no legitimate caller hits the empty-GUC path.
ALTER TABLE paperclip_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE paperclip_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paperclip_own_policy ON paperclip_state;
CREATE POLICY paperclip_own_policy ON paperclip_state
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  )
  WITH CHECK (
    user_entra_id = current_setting('app.current_user_entra_id', true)
  );
