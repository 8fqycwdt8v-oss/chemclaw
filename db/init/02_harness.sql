-- Phase A.2: harness support tables.
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- No RLS — these are system metadata tables, not user-scoped.

BEGIN;

-- ── tools ────────────────────────────────────────────────────────────────────
-- Catalog of tools the registry exposes to the agent harness.
-- source='builtin'  → execute impl is registered in-process.
-- source='mcp'      → execute impl calls mcp_url+mcp_endpoint via HTTP POST.
-- source='skill'    → execute impl delegates to a skill pack (Phase B+).

CREATE TABLE IF NOT EXISTS tools (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name         text        UNIQUE NOT NULL,
  source       text        NOT NULL CHECK (source IN ('builtin','mcp','skill')),
  schema_json  jsonb       NOT NULL,
  mcp_url      text,          -- only used when source='mcp'
  mcp_endpoint text,          -- only used when source='mcp'
  description  text        NOT NULL,
  enabled      boolean     NOT NULL DEFAULT true,
  version      int         NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tools_enabled_name ON tools(enabled, name);

-- ── mcp_tools ────────────────────────────────────────────────────────────────
-- Catalog of MCP services the registry can reach.
-- Populated at startup via seed / migration; health is probed at boot.

CREATE TABLE IF NOT EXISTS mcp_tools (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_name      text        UNIQUE NOT NULL,   -- e.g. 'mcp-rdkit'
  base_url          text        NOT NULL,
  enabled           boolean     NOT NULL DEFAULT true,
  last_health_check timestamptz,
  health_status     text        CHECK (health_status IN ('healthy','degraded','unknown') OR health_status IS NULL),
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

COMMIT;
