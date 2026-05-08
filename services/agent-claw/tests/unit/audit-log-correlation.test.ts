// Verifies that appendAudit auto-populates request_id and trace_id from
// the active AsyncLocalStorage RequestContext + OTel span. Pre-fix the
// admin_audit_log schema only carried {actor, action, target,
// before_value, after_value, reason} so an alert on "config.set on PROD
// secret bucket" couldn't be linked to the originating HTTP request
// without time-window grep.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { Pool, QueryResult } from "pg";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace } from "@opentelemetry/api";

import { appendAudit } from "../../src/routes/admin/audit-log.js";
import { runWithRequestContext } from "../../src/core/request-context.js";

interface CapturedQuery {
  sql: string;
  params: readonly unknown[];
}

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

beforeEach(() => {
  exporter.reset();
});

function makePool(captured: CapturedQuery[]): Pool {
  return {
    connect: async () => ({
      query: async <T = unknown>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<QueryResult<T>> => {
        const text = typeof sql === "string" ? sql : "";
        if (
          text.startsWith("BEGIN") ||
          text.startsWith("COMMIT") ||
          text.startsWith("ROLLBACK") ||
          text.startsWith("SELECT set_config")
        ) {
          return { rows: [] as T[], rowCount: 0, command: "SET", oid: 0, fields: [] };
        }
        if (text.includes("INSERT INTO admin_audit_log")) {
          captured.push({ sql: text, params: params ?? [] });
          return {
            rows: [{ id: "11111111-1111-1111-1111-111111111111" } as unknown as T],
            rowCount: 1,
            command: "INSERT",
            oid: 0,
            fields: [],
          };
        }
        return { rows: [] as T[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
}

describe("appendAudit correlation", () => {
  it("populates request_id from AsyncLocalStorage RequestContext", async () => {
    const captured: CapturedQuery[] = [];
    const pool = makePool(captured);
    await runWithRequestContext(
      {
        userEntraId: "alice@example.com",
        requestId: "req-abc-123",
      },
      async () => {
        await appendAudit(pool, {
          actor: "alice@example.com",
          action: "config.set",
          target: "monty.enabled",
        });
      },
    );
    expect(captured).toHaveLength(1);
    // Param order in the INSERT: actor, action, target, before, after,
    // reason, request_id, trace_id (positions 7, 8 0-indexed = indices 6, 7).
    const params = captured[0]!.params;
    expect(params[6]).toBe("req-abc-123");
    expect(params[7]).toBeNull(); // no active OTel span
  });

  it("populates trace_id from the active OTel span", async () => {
    const captured: CapturedQuery[] = [];
    const pool = makePool(captured);
    const tracer = trace.getTracer("test");
    await tracer.startActiveSpan("admin-mutation", async (span) => {
      await runWithRequestContext(
        {
          userEntraId: "alice@example.com",
          requestId: "req-xyz",
        },
        async () => {
          await appendAudit(pool, {
            actor: "alice@example.com",
            action: "redaction_pattern.add",
            target: "uuid-xyz",
          });
        },
      );
      span.end();
    });
    const params = captured[0]!.params;
    expect(typeof params[7]).toBe("string");
    expect((params[7] as string).length).toBeGreaterThan(0);
    expect(params[7]).not.toBe("00000000000000000000000000000000");
  });

  it("explicit overrides win over context lookups", async () => {
    const captured: CapturedQuery[] = [];
    const pool = makePool(captured);
    await runWithRequestContext(
      { userEntraId: "alice@example.com", requestId: "req-from-ctx" },
      async () => {
        await appendAudit(pool, {
          actor: "alice@example.com",
          action: "x",
          target: "y",
          requestId: "req-explicit",
          traceId: "tr-explicit",
        });
      },
    );
    const params = captured[0]!.params;
    expect(params[6]).toBe("req-explicit");
    expect(params[7]).toBe("tr-explicit");
  });

  it("absent context yields NULL columns (additive, no schema break)", async () => {
    const captured: CapturedQuery[] = [];
    const pool = makePool(captured);
    // No runWithRequestContext, no active span.
    await appendAudit(pool, {
      actor: "alice@example.com",
      action: "x",
      target: "y",
    });
    const params = captured[0]!.params;
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
  });

  // Defensive: vi import isn't needed but keeps lint happy if the test
  // is later expanded to spy on something.
  void vi;
});
