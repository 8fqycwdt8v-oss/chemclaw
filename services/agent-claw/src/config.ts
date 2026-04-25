// Agent-claw service configuration — validated from environment at startup.
// All env vars parsed via Zod; the service refuses to start on any validation failure.

import { z } from "zod";

const ConfigSchema = z.object({
  AGENT_HOST: z.string().default("0.0.0.0"),
  // Port 3101 — legacy agent stays on 3100 during parallel deployment.
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(3101),
  AGENT_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Comma-separated list of allowed CORS origins.
  AGENT_CORS_ORIGINS: z
    .string()
    .default("http://localhost:8501,http://127.0.0.1:8501"),

  // Body size cap for POST endpoints (bytes).
  AGENT_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1_048_576), // 1 MiB

  // Rate limit: max requests per window per IP.
  AGENT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AGENT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Per-turn step cap (hard limit: 40, matching the Phase 4 DR mode cap).
  AGENT_CHAT_MAX_STEPS: z.coerce.number().int().positive().max(40).default(40),

  // Token budget per turn. Guards against runaway loops consuming the context window.
  AGENT_TOKEN_BUDGET: z.coerce.number().int().positive().default(120_000),

  // Chat-specific rate limit (lower than the global rate limit).
  AGENT_CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AGENT_CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Per-message character cap and total history cap.
  AGENT_CHAT_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(40_000),
  AGENT_CHAT_MAX_HISTORY: z.coerce.number().int().positive().max(200).default(40),

  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().default("chemclaw"),
  POSTGRES_USER: z.string().default("chemclaw"),
  POSTGRES_PASSWORD: z.string().min(1, "POSTGRES_PASSWORD must be non-empty"),
  // Server-side per-query cap (ms). Prevents runaway queries from holding connections.
  POSTGRES_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(15_000),
  // Connection acquisition timeout (ms). Fail fast if Postgres is down.
  POSTGRES_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10_000),
  POSTGRES_POOL_SIZE: z.coerce.number().int().positive().default(20),

  MCP_RDKIT_URL: z.string().url().default("http://localhost:8001"),
  MCP_DRFP_URL: z.string().url().default("http://localhost:8002"),
  MCP_KG_URL: z.string().url().default("http://localhost:8003"),
  MCP_EMBEDDER_URL: z.string().url().default("http://localhost:8004"),
  MCP_TABICL_URL: z.string().url().default("http://localhost:8005"),
  MCP_DOC_FETCHER_URL: z.string().url().default("http://localhost:8006"),

  // LiteLLM proxy — single egress chokepoint for all LLM traffic.
  LITELLM_BASE_URL: z.string().url().default("http://localhost:4000"),
  LITELLM_API_KEY: z
    .string()
    .min(1)
    .default("sk-chemclaw-dev-master-change-me"),
  // Default model name as configured in services/litellm/config.yaml.
  AGENT_MODEL: z.string().min(1).default("claude-opus-4-7"),

  CHEMCLAW_DEV_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  CHEMCLAW_DEV_USER_EMAIL: z.string().default("dev@local.test"),

  // E2B sandbox — programmatic tool calling (Phase D.1).
  // E2B_API_KEY must be set to a real key in production; in dev/test the sandbox is mocked.
  E2B_API_KEY: z.string().default("e2b-dev-mock-key"),
  // E2B template ID — defaults to a Python 3.11 base image.
  E2B_TEMPLATE_ID: z.string().default("python-3-11"),

  // Path on disk where forged tool Python files are written.
  FORGED_TOOLS_DIR: z.string().default("/var/lib/chemclaw/forged_tools"),

  // ---------------------------------------------------------------------------
  // Paperclip-lite sidecar (Phase D.2).
  // When unset, the harness falls back to local-only budget (core/budget.ts).
  // ---------------------------------------------------------------------------
  PAPERCLIP_URL: z.string().url().optional(),

  // ---------------------------------------------------------------------------
  // Langfuse observability (Phase D.2).
  // When unset, spans are no-ops.
  // ---------------------------------------------------------------------------
  LANGFUSE_HOST: z.string().url().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),

  // ---------------------------------------------------------------------------
  // Multi-model routing (Phase D.2).
  // Each role maps to a LiteLLM model alias.
  // ---------------------------------------------------------------------------
  AGENT_MODEL_PLANNER: z.string().default("planner"),
  AGENT_MODEL_EXECUTOR: z.string().default("executor"),
  AGENT_MODEL_COMPACTOR: z.string().default("compactor"),
  AGENT_MODEL_JUDGE: z.string().default("judge"),

  // ---------------------------------------------------------------------------
  // Cross-model agreement (Phase D.2 / C.5 signal 2).
  // Off by default to keep dev/test cheap. Set to "true" in production.
  // ---------------------------------------------------------------------------
  AGENT_CONFIDENCE_CROSS_MODEL: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error(
      "Invalid configuration:",
      parsed.error.flatten().fieldErrors,
    );
    process.exit(1);
  }
  return parsed.data;
}
