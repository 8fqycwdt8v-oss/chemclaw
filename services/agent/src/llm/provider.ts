// LLM provider factory — routes every call through LiteLLM.
//
// Security posture:
//   - Base URL and API key come from validated config; never hard-coded
//   - We use @ai-sdk/openai with a custom `baseURL` pointing at LiteLLM's
//     OpenAI-compatible endpoint. LiteLLM applies the redactor callback
//     BEFORE the prompt leaves the cluster — this is the single egress
//     chokepoint for all model traffic.
//   - LITELLM_API_KEY is the LiteLLM master key, not a provider key —
//     upstream provider keys never reach this process.

import { createOpenAI } from "@ai-sdk/openai";
import type { Config } from "../config.js";

export interface LlmProvider {
  /** Returns a configured language-model handle usable with the AI SDK. */
  model(): ReturnType<ReturnType<typeof createOpenAI>>;
}

export function createLlmProvider(cfg: Config): LlmProvider {
  // `createOpenAI` returns a factory that produces model instances.
  const factory = createOpenAI({
    baseURL: `${cfg.LITELLM_BASE_URL.replace(/\/$/, "")}/v1`,
    apiKey: cfg.LITELLM_API_KEY,
    // Avoid sending the optional `OpenAI-Organization` header.
    compatibility: "compatible",
  });

  return {
    model: () => factory(cfg.AGENT_MODEL),
  };
}
