// POST /api/internal/workflows/sub_agent — JWT-authenticated entry point
// for the workflow_engine's sub_agent step kind.
//
// The engine mints a JWT (audience='agent-claw', scope='agent:sub_agent')
// and POSTs a goal + user_entra_id + agent type. We verify the token,
// re-derive the RLS scope from the signed claims (NOT from the body), and
// run a single-shot sub-agent harness via spawnSubAgent.
//
// Why a separate route rather than reusing /api/internal/sessions/:id/resume:
//   resume is bound to an existing session (todos, scratchpad, plan). A
//   workflow-spawned sub-agent has no parent session — the workflow event
//   log is its provenance trail. Same JWT scheme, different scope literal,
//   different handler.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type { ToolRegistry } from "../tools/registry.js";
import { lifecycle as runtimeLifecycle } from "../core/runtime.js";
import { spawnSubAgent } from "../core/sub-agent.js";
import type { SubAgentType, ToolContext } from "../core/types.js";
import { McpAuthError, verifyBearerHeader } from "../security/mcp-tokens.js";
import { getLogger } from "../observability/logger.js";

const SUB_AGENT_TYPES = ["chemist", "analyst", "reader"] as const satisfies readonly SubAgentType[];

const SubAgentRequest = z.object({
  goal: z.string().min(1).max(4000),
  user_entra_id: z.string().min(1).max(256),
  type: z.enum(SUB_AGENT_TYPES).default("analyst"),
  max_steps: z.number().int().min(1).max(50).default(10),
  inputs: z.record(z.unknown()).default({}),
});

interface WorkflowSubAgentDeps {
  pool: Pool;
  config?: Config;
  llm?: LlmProvider;
  registry?: ToolRegistry;
}

export function registerWorkflowSubAgentRoute(
  app: FastifyInstance,
  deps: WorkflowSubAgentDeps,
): void {
  app.post("/api/internal/workflows/sub_agent", (req, reply) =>
    handleWorkflowSubAgent(req, reply, deps),
  );
}

export async function handleWorkflowSubAgent(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: WorkflowSubAgentDeps,
): Promise<unknown> {
  const log = getLogger("agent-claw.routes.workflow_sub_agent");

  if (!deps.config || !deps.llm || !deps.registry) {
    return await reply.code(500).send({ error: "harness_deps_missing" });
  }

  // 1. Verify the bearer token. Audience is bound to "agent-claw"; scope
  // must be exactly "agent:sub_agent". Other scopes (agent:resume etc.)
  // cannot be replayed against this route.
  const authz = req.headers.authorization;
  let claimedUser: string;
  try {
    const claims = verifyBearerHeader(typeof authz === "string" ? authz : undefined, {
      requiredScope: "agent:sub_agent",
      expectedAudience: "agent-claw",
    });
    if (!claims) {
      return await reply.code(401).send({
        error: "unauthenticated",
        detail: "Authorization: Bearer <jwt> required",
      });
    }
    claimedUser = claims.user;
  } catch (err) {
    if (err instanceof McpAuthError) {
      return await reply.code(401).send({ error: "unauthenticated", detail: err.message });
    }
    throw err;
  }

  // 2. Validate the body.
  let body: z.infer<typeof SubAgentRequest>;
  try {
    body = SubAgentRequest.parse(req.body);
  } catch (err) {
    return await reply.code(400).send({
      error: "invalid_input",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. Cross-check claimed user against body.user_entra_id. Differing
  // values are a signal that either the engine is mis-wired or someone is
  // attempting to spoof the RLS scope; reject loudly so the engine's
  // logs surface the drift instead of silently letting one user's RLS
  // be used for another user's body.
  if (body.user_entra_id !== claimedUser) {
    log.warn(
      {
        event: "workflow_sub_agent_user_mismatch",
        body_user: body.user_entra_id,
        claimed_user: claimedUser,
      },
      "workflow sub_agent body user_entra_id differs from token claims.user — rejecting",
    );
    return await reply.code(403).send({
      error: "user_mismatch",
      detail: "body.user_entra_id must match token claims.user",
    });
  }

  // 4. Build a minimal ToolContext rooted at the claimed user. The
  // sub-agent's own scratchpad/seenFactIds are created inside
  // spawnSubAgent; we pass an empty parent context so nothing leaks
  // across workflow runs.
  const parentCtx: ToolContext = {
    userEntraId: claimedUser,
    orgId: null,
    nceProjectId: null,
    seenFactIds: new Set<string>(),
    scratchpad: new Map<string, unknown>(),
  };

  try {
    const result = await spawnSubAgent(
      body.type,
      {
        goal: body.goal,
        inputs: body.inputs,
        max_steps: body.max_steps,
      },
      parentCtx,
      {
        allTools: deps.registry.all(),
        llm: deps.llm,
        lifecycle: runtimeLifecycle,
      },
    );
    return await reply.code(200).send({
      text: result.text,
      finish_reason: result.finishReason,
      citations: result.citations,
      steps_used: result.stepsUsed,
      usage: result.usage,
    });
  } catch (err) {
    log.error(
      { err, event: "workflow_sub_agent_failed" },
      "workflow sub_agent harness threw",
    );
    return await reply.code(500).send({
      error: "sub_agent_failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
