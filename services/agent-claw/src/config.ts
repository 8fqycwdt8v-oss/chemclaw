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
