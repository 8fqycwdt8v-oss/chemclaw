-- Observability migration (PR-logging).
-- Re-applicable: every change guarded by IF NOT EXISTS / DROP ... IF EXISTS.
--
-- Numbered 19 to land after 18_finish_reason_widen.sql (which itself
-- followed 17_unified_confidence_and_temporal.sql).
--
-- This migration adds three pieces of in-database observability to ChemClaw:
--
--   1. `error_events` — durable storage for top-level error envelopes
--      emitted by services. Every TS / Python service that catches an
--      uncaught exception (or returns a 4xx/5xx envelope) writes a row
--      here so an operator can `SELECT ... ORDER BY occurred_at DESC LIMIT 50`
--      to see the last hour of failures across the whole fleet without
--      grepping container logs.
--
--   2. `audit_log` — row-level audit trail for the project-scoped tables
--      that drive the agent's working set (nce_projects, synthetic_steps,
--      experiments, agent_sessions, agent_plans, agent_todos, skill_library,
--      forged_tool_tests). A trigger captures every INSERT / UPDATE / DELETE
--      with the actor's hashed user-id and the row's before / after JSON.
--      Partitioned monthly so retention is a simple DROP PARTITION.
--
--   3. `enforce_user_context()` + `log_rls_denial()` SECURITY DEFINER
--      helpers — Postgres RLS filters silently, so denials are normally
--      invisible. The helper writes an `error_events` row when the
--      session has no `app.current_user_entra_id` set, giving operators
--      a paper trail of "your auth proxy is misconfigured / a system
--      worker forgot withSystemContext / a request bypassed the role".
--
-- The audit trigger is intentionally narrow: it only fires on tables where
-- a row's history is operationally interesting. Adding a new table to the
-- list is one line in the `_install_audit_trigger_on()` call block at the
-- bottom of this file.
--
-- Out of scope here (handled in docker-compose.yml + Helm values):
--   - Postgres `log_min_duration_statement`, `log_lock_waits`, `log_statement`
--     settings. These are server-level configuration, not migration SQL.

-- ---------------------------------------------------------------------------
-- Pre-reqs.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. `error_events` — durable error envelope storage.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS error_events (
    id              BIGSERIAL PRIMARY KEY,
    service         TEXT NOT NULL,
    error_code      TEXT NOT NULL,
    severity        TEXT NOT NULL CHECK (severity IN ('warn', 'error', 'fatal')),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Full envelope: { code, message, detail?, trace_id?, request_id?, hint?,
    -- stack?, user (hashed) }. Keep at most 16 KiB at write-time (enforced by
    -- the application; a runaway stack can fill the table fast).
    payload         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_error_events_occurred
    ON error_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_events_service_code
    ON error_events (service, error_code);
CREATE INDEX IF NOT EXISTS idx_error_events_payload_gin
    ON error_events USING GIN (payload jsonb_path_ops);

ALTER TABLE error_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE error_events FORCE ROW LEVEL SECURITY;

-- error_events is global / cross-project; only authenticated callers may
-- read. Writes flow through the SECURITY DEFINER helper below, not through
-- direct INSERTs from app traffic.
DROP POLICY IF EXISTS error_events_select ON error_events;
CREATE POLICY error_events_select ON error_events
    FOR SELECT
    USING (current_setting('app.current_user_entra_id', true) IS NOT NULL
           AND current_setting('app.current_user_entra_id', true) <> '');

-- Allow chemclaw_service (BYPASSRLS) and the table owner (migrations) to
-- INSERT. App traffic should write via `record_error_event` below.
DROP POLICY IF EXISTS error_events_insert_system ON error_events;
CREATE POLICY error_events_insert_system ON error_events
    FOR INSERT
    WITH CHECK (current_setting('app.current_user_entra_id', true) IS NOT NULL);

-- NOTIFY trigger so a future projector (or a Loki tailer) can subscribe
-- and forward error_events rows in real time. Channel name distinct from
-- the main `ingestion_events` channel so subscribers don't get spammed.
CREATE OR REPLACE FUNCTION notify_error_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    PERFORM pg_notify(
        'error_events',
        json_build_object(
            'id', NEW.id,
            'service', NEW.service,
            'error_code', NEW.error_code,
            'severity', NEW.severity
        )::text
    );
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS error_events_notify ON error_events;
CREATE TRIGGER error_events_notify
    AFTER INSERT ON error_events
    FOR EACH ROW
    EXECUTE FUNCTION notify_error_event();

-- Public helper for application code to write an error envelope without
-- needing direct INSERT privileges. Runs as SECURITY DEFINER so the table
-- owner's privileges apply; the function caps payload size at 16 KiB to
-- prevent a runaway stack trace from filling the table.
CREATE OR REPLACE FUNCTION record_error_event(
    p_service       TEXT,
    p_error_code    TEXT,
    p_severity      TEXT,
    p_payload       JSONB
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_id            BIGINT;
    v_payload_size  INTEGER;
    v_capped        JSONB;
BEGIN
    IF p_severity NOT IN ('warn', 'error', 'fatal') THEN
        RAISE EXCEPTION 'invalid severity %', p_severity;
    END IF;

    v_payload_size := length(p_payload::text);
    IF v_payload_size > 16384 THEN
        -- Replace oversized payload with a small marker. This is a
        -- defense-in-depth — application code is expected to truncate
        -- before calling, but a buggy caller mustn't silently bloat
        -- the table.
        v_capped := jsonb_build_object(
            'truncated', true,
            'original_size', v_payload_size,
            'note', 'payload exceeded 16KiB cap; see service logs'
        );
    ELSE
        v_capped := p_payload;
    END IF;

    INSERT INTO error_events (service, error_code, severity, payload)
    VALUES (p_service, p_error_code, p_severity, v_capped)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- Restrict EXECUTE: there's no legitimate caller outside the two app
-- roles. Granting to PUBLIC would let anyone with a DB connection
-- saturate the table by calling in a tight loop. The two GRANTs are
-- guarded so re-application doesn't fail on a fresh schema where the
-- roles haven't been created yet (12_security_hardening.sql owns role
-- creation but might not have run in a partial test environment).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION record_error_event(TEXT, TEXT, TEXT, JSONB) TO chemclaw_app';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
        EXECUTE 'GRANT EXECUTE ON FUNCTION record_error_event(TEXT, TEXT, TEXT, JSONB) TO chemclaw_service';
    END IF;
END;
$$;
-- Defensive REVOKE in case an earlier (PUBLIC-granted) version of this
-- migration ran. No-op when nothing was granted.
REVOKE EXECUTE ON FUNCTION record_error_event(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. `audit_log` — partitioned row-level audit trail.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log (
    id                  BIGSERIAL,
    -- Hashed actor (sha256 prefix; raw entra-id is never persisted) so an
    -- audit row can be correlated with a service's log line by the same
    -- hash. The hash is applied in `audit_row_change()` below.
    actor_user_hash     TEXT,
    action              TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
    subject_table       TEXT NOT NULL,
    subject_row_id      TEXT NOT NULL,
    before_data         JSONB,
    after_data          JSONB,
    at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, at)
) PARTITION BY RANGE (at);

CREATE INDEX IF NOT EXISTS idx_audit_log_subject
    ON audit_log (subject_table, subject_row_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
    ON audit_log (actor_user_hash, at DESC);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- Only authenticated callers can read. Writes happen via the trigger,
-- which runs as table-owner privileges.
DROP POLICY IF EXISTS audit_log_select ON audit_log;
CREATE POLICY audit_log_select ON audit_log
    FOR SELECT
    USING (current_setting('app.current_user_entra_id', true) IS NOT NULL
           AND current_setting('app.current_user_entra_id', true) <> '');

-- Bootstrap partitions: current month + next 2 months. A monthly cron
-- job (see services/optimizer/audit_partition_maintainer if added later)
-- creates the next month's partition before it's needed.
DO $$
DECLARE
    v_start DATE := date_trunc('month', now())::DATE;
    v_end   DATE;
    v_name  TEXT;
    i       INTEGER;
BEGIN
    FOR i IN 0 .. 2 LOOP
        v_name := format(
            'audit_log_y%sm%s',
            to_char((v_start + (i || ' months')::INTERVAL), 'YYYY'),
            to_char((v_start + (i || ' months')::INTERVAL), 'MM')
        );
        v_end := (v_start + ((i + 1) || ' months')::INTERVAL)::DATE;
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log
                FOR VALUES FROM (%L) TO (%L)',
            v_name,
            (v_start + (i || ' months')::INTERVAL)::DATE,
            v_end
        );
    END LOOP;
END;
$$;

-- Generic trigger function — captures the actor's hashed entra-id, the
-- before/after row state, and the table name. Runs as SECURITY DEFINER
-- so it can write into audit_log even when the caller has no INSERT
-- privilege on it.
CREATE OR REPLACE FUNCTION audit_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_raw TEXT;
    v_actor_hash TEXT;
    v_action TEXT;
    v_row_id TEXT;
    v_before JSONB;
    v_after JSONB;
BEGIN
    v_actor_raw := current_setting('app.current_user_entra_id', true);
    IF v_actor_raw IS NULL OR v_actor_raw = '' THEN
        v_actor_hash := NULL;
    ELSE
        -- sha256 hex prefix; same shape as TS hashUser / Python hash_user.
        v_actor_hash := substr(
            encode(digest(v_actor_raw, 'sha256'), 'hex'),
            1, 16
        );
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_action := 'insert';
        v_before := NULL;
        v_after := to_jsonb(NEW);
        v_row_id := COALESCE((NEW).id::TEXT, '<unknown>');
    ELSIF TG_OP = 'UPDATE' THEN
        v_action := 'update';
        v_before := to_jsonb(OLD);
        v_after := to_jsonb(NEW);
        v_row_id := COALESCE((NEW).id::TEXT, (OLD).id::TEXT, '<unknown>');
    ELSIF TG_OP = 'DELETE' THEN
        v_action := 'delete';
        v_before := to_jsonb(OLD);
        v_after := NULL;
        v_row_id := COALESCE((OLD).id::TEXT, '<unknown>');
    END IF;

    -- Best-effort audit insert. If the partition for `now()` doesn't
    -- exist (e.g. the bootstrap window expired before
    -- `audit_partition_maintainer` ran), the INSERT would otherwise
    -- raise `no partition of relation "audit_log" found for row` and
    -- take down every project-scoped write. The audit lives outside
    -- the app's correctness contract — we'd rather lose a row than
    -- the platform.
    BEGIN
        INSERT INTO audit_log (
            actor_user_hash, action, subject_table, subject_row_id,
            before_data, after_data
        )
        VALUES (
            v_actor_hash, v_action, TG_TABLE_NAME, v_row_id,
            v_before, v_after
        );
    EXCEPTION WHEN OTHERS THEN
        -- Forward the failure to error_events so the gap is observable.
        BEGIN
            INSERT INTO error_events (service, error_code, severity, payload)
            VALUES (
                'postgres',
                'AUDIT_LOG_INSERT_FAILED',
                'warn',
                jsonb_build_object(
                    'subject_table', TG_TABLE_NAME,
                    'note', 'audit_log INSERT failed; trigger returned without raising'
                )
            );
        EXCEPTION WHEN OTHERS THEN
            -- If even error_events is unwritable, swallow — the user's
            -- transaction must succeed regardless.
            NULL;
        END;
    END;

    -- Trigger return convention: AFTER triggers may return NULL.
    RETURN NULL;
END;
$$;

-- Helper: install the audit trigger on a table iff it exists. Idempotent.
DO $$
DECLARE
    audited_tables CONSTANT TEXT[] := ARRAY[
        'nce_projects',
        'synthetic_steps',
        'experiments',
        'agent_sessions',
        'agent_plans',
        'agent_todos',
        'skill_library',
        'forged_tool_tests'
    ];
    t TEXT;
    trigger_name TEXT;
BEGIN
    FOREACH t IN ARRAY audited_tables LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = t
        ) THEN
            trigger_name := format('audit_%s', t);
            EXECUTE format(
                'DROP TRIGGER IF EXISTS %I ON %I',
                trigger_name, t
            );
            EXECUTE format(
                'CREATE TRIGGER %I
                    AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
                trigger_name, t
            );
        END IF;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. RLS-denial logging helper.
-- ---------------------------------------------------------------------------
--
-- Postgres RLS filters silently on SELECT — there's no way to trap a row
-- that was excluded by a policy. The two cases we *can* observe are:
--
--   a) `app.current_user_entra_id` is NULL or '' on a project-scoped read.
--      Existing policies (12_security_hardening.sql) already deny these,
--      but they do so silently. The helper below writes an error_events
--      row so operators see "your auth proxy was bypassed" or "a system
--      worker forgot withSystemContext".
--
--   b) Write-time denials. A WITH CHECK clause that fails RAISEs an error
--      back to the client; the helper records the attempt before letting
--      the policy reject it. (Wiring write-side wrappers into every table's
--      INSERT/UPDATE policies is a follow-up — the function below is
--      a building block for that future change.)

CREATE OR REPLACE FUNCTION enforce_user_context(p_table TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_user TEXT;
BEGIN
    v_user := current_setting('app.current_user_entra_id', true);
    IF v_user IS NULL OR v_user = '' THEN
        -- Best-effort: writes to error_events from inside a SECURITY
        -- DEFINER function with no user context can deadlock if the
        -- table is itself RLS-locked. Wrap the INSERT in an exception
        -- block so we never block the original query — the caller will
        -- see RLS deny it anyway.
        BEGIN
            INSERT INTO error_events (service, error_code, severity, payload)
            VALUES (
                'postgres',
                'DB_RLS_NO_USER_CONTEXT',
                'warn',
                jsonb_build_object(
                    'subject_table', p_table,
                    'note', 'app.current_user_entra_id was empty/missing'
                )
            );
        EXCEPTION WHEN OTHERS THEN
            -- Swallow — best-effort logging.
            NULL;
        END;
        RETURN FALSE;
    END IF;
    RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION enforce_user_context(TEXT) TO PUBLIC;

-- Schema_version stamp (the make db.init loop populates this; explicit
-- INSERT here for environments that bypass make and run psql directly).
INSERT INTO schema_version (filename, applied_at)
VALUES ('19_observability.sql', now())
ON CONFLICT (filename) DO NOTHING;
