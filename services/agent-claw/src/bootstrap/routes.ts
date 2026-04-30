// Route registration aggregation.
//
// Extracted from index.ts as part of the PR-6 god-file split. Every
// /api/* route is registered here in one place so callers (index.ts +
// any future test bootstrap) get a single function to call.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Deps } from "./dependencies.js";
import { registerHealthzRoute } from "../routes/healthz.js";
import { registerChatRoute } from "../routes/chat.js";
import { registerDeepResearchRoute } from "../routes/deep-research.js";
import { registerSkillsRoutes } from "../routes/skills.js";
import { registerPlanRoutes } from "../routes/plan.js";
import { registerDocumentsRoute } from "../routes/documents.js";
import { registerArtifactsRoutes } from "../routes/artifacts.js";
import { registerLearnRoute } from "../routes/learn.js";
import { registerFeedbackRoute } from "../routes/feedback.js";
import { registerEvalRoute } from "../routes/eval.js";
import { registerOptimizerRoutes } from "../routes/optimizer.js";
import { registerSessionsRoute } from "../routes/sessions.js";

export function registerAllRoutes(
  app: FastifyInstance,
  cfg: Config,
  deps: Deps,
  getUser: (req: FastifyRequest) => string,
): void {
  registerHealthzRoute(app);

  const routeDeps = {
    config: cfg,
    pool: deps.pool,
    llm: deps.llmProvider,
    registry: deps.registry,
    promptRegistry: deps.promptRegistry,
    skillLoader: deps.skillLoader,
    paperclip: deps.paperclipClient,
    shadowEvaluator: deps.shadowEvaluator,
    getUser,
  };

  registerChatRoute(app, routeDeps);
  registerDeepResearchRoute(app, routeDeps);
  registerSkillsRoutes(app, {
    loader: deps.skillLoader,
    pool: deps.pool,
    getUser,
  });
  registerPlanRoutes(app, routeDeps);
  registerDocumentsRoute(app, { config: cfg, pool: deps.pool, getUser });
  registerArtifactsRoutes(app, { pool: deps.pool, getUser });
  registerLearnRoute(app, { pool: deps.pool, llm: deps.llmProvider, getUser });
  registerFeedbackRoute(app, {
    pool: deps.pool,
    promptRegistry: deps.promptRegistry,
    getUser,
    langfuseHost: cfg.LANGFUSE_HOST,
    langfusePublicKey: cfg.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: cfg.LANGFUSE_SECRET_KEY,
  });
  registerEvalRoute(app, {
    config: cfg,
    pool: deps.pool,
    promptRegistry: deps.promptRegistry,
    llm: deps.llmProvider,
    getUser,
  });
  registerOptimizerRoutes(app, {
    pool: deps.pool,
    getUser,
  });
  registerSessionsRoute(app, {
    pool: deps.pool,
    getUser,
    // Phase E + I: chained-run + resume endpoints share the chat harness deps.
    config: cfg,
    llm: deps.llmProvider,
    registry: deps.registry,
    promptRegistry: deps.promptRegistry,
    // Same Paperclip client as the chat route — so chained-execution flows
    // are subject to the same daily-USD cap as a single chat turn.
    paperclip: deps.paperclipClient,
  });
}
