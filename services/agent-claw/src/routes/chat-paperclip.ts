// Paperclip reservation helper for the chat route.
//
// Extracted from routes/chat.ts. The chat handler reserves a per-turn
// budget against the Paperclip-lite sidecar before doing any LLM work
// so a daily-USD overrun surfaces as HTTP 429 with Retry-After before
// any response body opens.
//
// Three outcomes:
//   - paperclip not configured            → returns { ok: true, handle: null }
//   - reserve succeeds                    → returns { ok: true, handle }
//   - reserve raises PaperclipBudgetError → writes the 429 reply, returns
//                                            { ok: false }; caller must `return`
//
// Network/5xx are non-fatal — logged and treated as "no reservation",
// preserving the pre-Paperclip behaviour.

import type { FastifyBaseLogger, FastifyReply } from "fastify";
import {
  PaperclipBudgetError,
  type PaperclipClient,
  type ReservationHandle,
} from "../core/paperclip-client.js";

export type ReserveResult =
  | { ok: true; handle: ReservationHandle | null }
  | { ok: false };

export async function reserveTurnBudget(
  paperclip: PaperclipClient | undefined,
  reply: FastifyReply,
  user: string,
  sessionId: string | null,
  log: FastifyBaseLogger,
  onBudgetRefused: () => void,
): Promise<ReserveResult> {
  if (!paperclip) {
    return { ok: true, handle: null };
  }
  try {
    const handle = await paperclip.reserve({
      userEntraId: user,
      sessionId: sessionId ?? "stateless",
      estTokens: 12_000,
      estUsd: 0.05,
    });
    return { ok: true, handle };
  } catch (err: unknown) {
    if (err instanceof PaperclipBudgetError) {
      onBudgetRefused();
      await reply
        .code(429)
        .header("Retry-After", String(err.retryAfterSeconds))
        .send({
          error: "budget_exceeded",
          reason: err.reason,
          retry_after_seconds: err.retryAfterSeconds,
        });
      return { ok: false };
    }
    log.warn({ err }, "paperclip /reserve failed (non-fatal)");
    return { ok: true, handle: null };
  }
}
