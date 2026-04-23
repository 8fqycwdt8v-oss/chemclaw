// POST /api/chat — SSE-streaming chat endpoint.
//
// Contract:
//   Request:
//     { "messages": [{ "role": "user"|"assistant"|"system", "content": "..." }],
//       "stream": true|false (default true) }
//   Response (stream=true): text/event-stream with one JSON-encoded StreamEvent
//     per `data:` line. Terminated by a `finish` or `error` event.
//   Response (stream=false): JSON { "text": "...", "finishReason": "...",
//     "promptVersion": N }.
//
// Budget defences:
//   - Dedicated low rate limit on this route (AGENT_CHAT_RATE_LIMIT_MAX)
//   - Single-message length cap and total-history cap (both from config)
//   - Server-enforced maxSteps on the tool-use loop
//   - No user input is ever mixed into the system prompt — the registered
//     prompt is applied server-side; the user only provides the conversation
//     turns.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Config } from "../config.js";
import type { ChatAgent } from "../agent/chat-agent.js";
import { ChatMessageSchema } from "../agent/chat-agent.js";

export interface ChatRouteDeps {
  config: Config;
  agent: ChatAgent;
  getUser: (req: FastifyRequest) => string;
}

const ChatRequestSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  stream: z.boolean().optional(),
});

export function registerChatRoute(app: FastifyInstance, deps: ChatRouteDeps): void {
  app.post(
    "/api/chat",
    {
      // Per-route rate limit override. Leaves the generic limit in place
      // for other endpoints; chat is more expensive so gets its own bucket.
      config: {
        rateLimit: {
          max: deps.config.AGENT_CHAT_RATE_LIMIT_MAX,
          timeWindow: deps.config.AGENT_CHAT_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const user = deps.getUser(req);

      const parsed = ChatRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid_input",
          detail: parsed.error.issues.map((i) => ({
            path: i.path,
            msg: i.message,
          })),
        });
      }

      const { messages, stream = true } = parsed.data;

      // Defensive bounds — Pydantic-equivalent checks in Python.
      if (messages.length > deps.config.AGENT_CHAT_MAX_HISTORY) {
        return reply
          .code(413)
          .send({ error: "history_too_long", max: deps.config.AGENT_CHAT_MAX_HISTORY });
      }
      for (const m of messages) {
        if (m.content.length > deps.config.AGENT_CHAT_MAX_INPUT_CHARS) {
          return reply
            .code(413)
            .send({
              error: "message_too_long",
              max: deps.config.AGENT_CHAT_MAX_INPUT_CHARS,
            });
        }
      }

      if (!stream) {
        try {
          const result = await deps.agent.generate({
            userEntraId: user,
            messages,
          });
          return result;
        } catch (err) {
          req.log.error({ err }, "chat generate failed");
          return reply.code(500).send({ error: "internal" });
        }
      }

      // -------- SSE response --------
      reply.raw.statusCode = 200;
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no"); // nginx passthrough
      reply.hijack();

      const writeEvent = (payload: unknown): void => {
        // One JSON-encoded event per SSE frame. Ensure no embedded newlines
        // corrupt the wire format (SSE uses \n as a record separator).
        const json = JSON.stringify(payload).replace(/\r?\n/g, "\\n");
        reply.raw.write(`data: ${json}\n\n`);
      };

      let closed = false;
      const onClose = () => {
        closed = true;
      };
      req.raw.on("close", onClose);
      req.raw.on("aborted", onClose);

      try {
        for await (const evt of deps.agent.stream({
          userEntraId: user,
          messages,
        })) {
          if (closed) break;
          writeEvent(evt);
          if (evt.type === "finish" || evt.type === "error") {
            break;
          }
        }
      } catch (err) {
        req.log.error({ err }, "chat stream failed mid-flight");
        writeEvent({ type: "error", error: "internal" });
      } finally {
        try {
          reply.raw.end();
        } catch {
          // connection already closed
        }
      }
    },
  );
}
