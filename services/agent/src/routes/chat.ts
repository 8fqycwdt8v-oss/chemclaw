// POST /api/chat — SSE-streaming chat endpoint.
//
// Request shape:
//   { "messages": [...], "stream": true|false }
//
// Budget defences:
//   - Dedicated low rate limit
//   - Single-message length cap and total-history cap (from config)
//   - Server-enforced maxSteps on the agent loop
//   - No user input ever enters the system prompt; registered prompts apply
//     server-side
//   - SSE frames JSON-encoded with newline escape so model-emitted newlines
//     can't corrupt the wire format

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Config } from "../config.js";
import type { ChatAgent, StreamEvent } from "../agent/chat-agent.js";
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

type ChatRequest = z.infer<typeof ChatRequestSchema>;

function _enforceBounds(
  req: ChatRequest,
  config: Config,
): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
  if (req.messages.length > config.AGENT_CHAT_MAX_HISTORY) {
    return {
      ok: false,
      status: 413,
      body: { error: "history_too_long", max: config.AGENT_CHAT_MAX_HISTORY },
    };
  }
  for (const m of req.messages) {
    if (m.content.length > config.AGENT_CHAT_MAX_INPUT_CHARS) {
      return {
        ok: false,
        status: 413,
        body: {
          error: "message_too_long",
          max: config.AGENT_CHAT_MAX_INPUT_CHARS,
        },
      };
    }
  }
  return { ok: true };
}

async function _handle(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ChatRouteDeps,
): Promise<void> {
  const user = deps.getUser(req);
  const parsed = ChatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return void reply.code(400).send({
      error: "invalid_input",
      detail: parsed.error.issues.map((i) => ({ path: i.path, msg: i.message })),
    });
  }
  const body = parsed.data;
  const bounds = _enforceBounds(body, deps.config);
  if (!bounds.ok) {
    return void reply.code(bounds.status).send(bounds.body);
  }

  const stream = body.stream ?? true;

  if (!stream) {
    try {
      const result = await deps.agent.generate({
        userEntraId: user,
        messages: body.messages,
      });
      return void reply.send(result);
    } catch (err) {
      req.log.error({ err }, "chat generate failed");
      return void reply.code(500).send({ error: "internal" });
    }
  }

  // ---------- SSE response ----------
  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.hijack();

  const writeEvent = (payload: StreamEvent): void => {
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
      messages: body.messages,
    })) {
      if (closed) break;
      writeEvent(evt);
      if (evt.type === "finish" || evt.type === "error") break;
    }
  } catch (err) {
    req.log.error({ err }, "chat stream failed mid-flight");
    writeEvent({ type: "error", error: "internal" });
  } finally {
    try {
      reply.raw.end();
    } catch {
      // already closed
    }
  }
}

export function registerChatRoute(app: FastifyInstance, deps: ChatRouteDeps): void {
  app.post(
    "/api/chat",
    {
      config: {
        rateLimit: {
          max: deps.config.AGENT_CHAT_RATE_LIMIT_MAX,
          timeWindow: deps.config.AGENT_CHAT_RATE_LIMIT_WINDOW_MS,
        },
      },
    },
    (req, reply) => _handle(req, reply, deps),
  );
}
