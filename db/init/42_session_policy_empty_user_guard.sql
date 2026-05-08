-- Phase G hardening: tighten owner-scoped RLS to reject empty / unset
-- caller identity.
--
-- Background: 13_agent_sessions.sql and 14_agent_session_extensions.sql
-- guard SELECT / INSERT on agent_sessions, agent_todos, agent_plans by
--   user_entra_id = current_setting('app.current_user_entra_id', true)
-- The third argument to current_setting is `missing_ok=true`, so when
-- the GUC is unset the function returns NULL — which makes the predicate
-- NULL → falsy, so reads correctly fail closed.
--
-- The hole is the empty-string case. If a tool ever stores a row with
-- user_entra_id = '' (e.g. a forgotten withUserContext at insert), and a
-- caller later runs WITHOUT setting app.current_user_entra_id but with
-- a session-level GUC of '' (which would have to be deliberate, but
-- nothing prevents an admin endpoint from doing so), the predicate
--   '' = ''
-- evaluates to TRUE and unrelated rows surface.
--
-- This migration adds an explicit IS NOT NULL AND <> '' guard so the
-- predicate fails closed even in that edge case. The behaviour change
-- is invisible to legitimate callers (withUserContext always sets a
-- non-empty user_entra_id). Mirrors the pattern that paperclip_state
-- and feedback_events already follow.

BEGIN;

DROP POLICY IF EXISTS agent_sessions_owner_policy ON agent_sessions;
CREATE POLICY agent_sessions_owner_policy ON agent_sessions
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND user_entra_id = current_setting('app.current_user_entra_id', true)
  );

DROP POLICY IF EXISTS agent_todos_owner_policy ON agent_todos;
CREATE POLICY agent_todos_owner_policy ON agent_todos
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.id = agent_todos.session_id
         AND s.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.id = agent_todos.session_id
         AND s.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS agent_plans_via_session_policy ON agent_plans;
CREATE POLICY agent_plans_via_session_policy ON agent_plans
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.id = agent_plans.session_id
         AND s.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND EXISTS (
      SELECT 1 FROM agent_sessions s
       WHERE s.id = agent_plans.session_id
         AND s.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

COMMIT;
