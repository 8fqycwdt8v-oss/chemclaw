// Agent service configuration — loaded from environment.
// All env vars are validated via Zod; the service refuses to start with a bad config.

import { z } from "zod";

const ConfigSchema = z.object({
  AGENT_HOST: z.string().default("0.0.0.0"),
  AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  AGENT_LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // Comma-separated list of allowed CORS origins. Defaults to localhost only.
  AGENT_CORS_ORIGINS: z.string().default("http://localhost:8501,http://127.0.0.1:8501"),

  // Body size cap for POST endpoints (bytes).
  AGENT_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1_048_576), // 1 MiB

  // Rate limit: max requests per window per IP.
  AGENT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AGENT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  POSTGRES_HOST: z.string().default("localhost"),
  POSTGRES_PORT: z.coerce.number().int().default(5432),
  POSTGRES_DB: z.string().default("chemclaw"),
  POSTGRES_USER: z.string().default("chemclaw"),
  POSTGRES_PASSWORD: z.string().min(1, "POSTGRES_PASSWORD must be non-empty"),
  // Server-side per-query cap (ms). Keeps a runaway query from holding a
  // connection indefinitely. 0 disables (not recommended).
  POSTGRES_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(15_000),
  // Connection acquisition timeout (ms). If Postgres is down the agent's
  // handlers fail fast rather than hanging.
  POSTGRES_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  // Pool size — tune per deployment.
  POSTGRES_POOL_SIZE: z.coerce.number().int().positive().default(20),

  NEO4J_URI: z.string().default("bolt://localhost:7687"),
  NEO4J_USER: z.string().default("neo4j"),
  NEO4J_PASSWORD: z.string().min(1, "NEO4J_PASSWORD must be non-empty"),

  MCP_DRFP_URL: z.string().url().default("http://localhost:8002"),
  MCP_RDKIT_URL: z.string().url().default("http://localhost:8001"),
  MCP_KG_URL: z.string().url().default("http://localhost:8003"),
  MCP_EMBEDDER_URL: z.string().url().default("http://localhost:8004"),
  MCP_TABICL_URL: z.string().url().default("http://localhost:8005"),

  // LiteLLM proxy for LLM egress.
  LITELLM_BASE_URL: z.string().url().default("http://localhost:4000"),
  LITELLM_API_KEY: z.string().min(1).default("sk-chemclaw-dev-master-change-me"),
  // Default model name as configured in services/litellm/config.yaml.
  AGENT_MODEL: z.string().min(1).default("claude-opus-4-7"),

  // Chat-specific budgets (defence against runaway LLM loops).
  AGENT_CHAT_MAX_STEPS: z.coerce.number().int().positive().max(40).default(20),
  AGENT_CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  AGENT_CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Reject messages longer than this (single user turn).
  AGENT_CHAT_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(40_000),
  // Reject conversation histories with more than this many messages.
  AGENT_CHAT_MAX_HISTORY: z.coerce.number().int().positive().max(200).default(40),

  CHEMCLAW_DEV_MODE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  CHEMCLAW_DEV_USER_EMAIL: z.string().default("dev@local.test"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
