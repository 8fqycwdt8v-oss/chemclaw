// GET /api/documents/:id/original — proxy original-doc bytes to the caller.
//
// This is a thin convenience route for the future frontend's "Open original"
// affordance: the browser makes a GET request here, receives the raw bytes
// with the correct Content-Type header, and renders or triggers a browser
// download.
//
// Internally calls mcp-doc-fetcher /fetch with the document's original_uri.
// Requires the caller to pass the user Entra-ID via X-Dev-User-Entra-Id (dev)
// or X-User-Entra-Id (prod) so RLS is enforced on the document lookup.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { withUserContext } from "../db/with-user-context.js";
import { postJson } from "../mcp/postJson.js";
import { z } from "zod";

const _FetchOut = z.object({
  content_type: z.string(),
  base64_bytes: z.string(),
  byte_count: z.number(),
});

interface DocRow {
  id: string;
  original_uri: string | null;
  title: string | null;
}

export interface DocumentsRouteDeps {
  config: Config;
  pool: Pool;
  getUser: (req: FastifyRequest) => string;
}

export function registerDocumentsRoute(app: FastifyInstance, deps: DocumentsRouteDeps): void {
  app.get("/api/documents/:id/original", async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const user = deps.getUser(req);

    // Validate UUID format.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(id)) {
      return reply.code(400).send({ error: "invalid_document_id" });
    }

    // RLS-scoped document lookup.
    let row: DocRow | null = null;
    try {
      row = await withUserContext(deps.pool, user, async (client) => {
        const res = await client.query<DocRow>(
          `SELECT id, original_uri, title FROM documents WHERE id = $1`,
          [id],
        );
        return res.rows[0] ?? null;
      });
    } catch (err) {
      req.log.error({ err }, "documents/original: DB lookup failed");
      return reply.code(500).send({ error: "internal" });
    }

    if (!row) {
      return reply.code(404).send({ error: "document_not_found" });
    }
    if (!row.original_uri) {
      return reply.code(404).send({
        error: "no_original_uri",
        detail: "This document has no recorded original file URI.",
      });
    }

    // Fetch raw bytes from mcp-doc-fetcher.
    const base = deps.config.MCP_DOC_FETCHER_URL?.replace(/\/$/, "") ?? "";
    if (!base) {
      return reply.code(503).send({ error: "mcp_doc_fetcher_not_configured" });
    }

    let fetched: { content_type: string; base64_bytes: string; byte_count: number };
    try {
      fetched = await postJson(
        `${base}/fetch`,
        { uri: row.original_uri, max_bytes: 50_000_000 },
        _FetchOut,
        60_000,
        "mcp-doc-fetcher",
      );
    } catch (err) {
      req.log.error({ err }, "documents/original: mcp-doc-fetcher failed");
      return reply.code(502).send({ error: "upstream_failed" });
    }

    const bytes = Buffer.from(fetched.base64_bytes, "base64");

    // Derive a filename from title or ID.
    const safeName = (row.title ?? id).replace(/[^a-zA-Z0-9_.\- ]/g, "_").slice(0, 80);

    reply.raw.statusCode = 200;
    reply.raw.setHeader("Content-Type", fetched.content_type);
    reply.raw.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}"`,
    );
    reply.raw.setHeader("Content-Length", bytes.length);
    reply.hijack();
    reply.raw.end(bytes);
  });
}
