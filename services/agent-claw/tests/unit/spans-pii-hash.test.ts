// Verifies the BLOCKER fix: startRootTurnSpan must hash userEntraId
// before stamping `chemclaw.user` and `user.id` on the span. Span
// attributes ship via OTLP to Langfuse / external collectors and
// frequently end up shared with vendor support; raw entra ids are PII.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { startRootTurnSpan } from "../../src/observability/spans.js";
import { hashUser, __resetUserHashForTests } from "../../src/observability/user-hash.js";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  // Force-set the salt so hashUser doesn't fail-closed in test env.
  process.env.LOG_USER_SALT = "spans-pii-hash-test-salt";
  __resetUserHashForTests();
});

beforeEach(() => {
  exporter.reset();
});

describe("startRootTurnSpan PII hashing", () => {
  it("emits the hashed user id, never the raw entra id, on chemclaw.user", () => {
    const raw = "alice@example.com";
    const span = startRootTurnSpan({ traceId: "t1", userEntraId: raw });
    span.end();
    const finished = exporter.getFinishedSpans()[0];
    expect(finished).toBeDefined();
    if (!finished) return;
    expect(finished.attributes["chemclaw.user"]).toBe(hashUser(raw));
    expect(finished.attributes["chemclaw.user"]).not.toBe(raw);
    expect(finished.attributes["chemclaw.user"]).not.toContain("@");
  });

  it("emits the hashed user id on the Langfuse-recognised user.id attribute", () => {
    const raw = "00000000-0000-0000-0000-deadbeefface";
    const span = startRootTurnSpan({ traceId: "t2", userEntraId: raw });
    span.end();
    const finished = exporter.getFinishedSpans()[0];
    expect(finished?.attributes["user.id"]).toBe(hashUser(raw));
    expect(finished?.attributes["user.id"]).not.toBe(raw);
  });

  it("matching raw entra ids hash to the same value (correlation invariant)", () => {
    const raw = "bob@example.com";
    const span1 = startRootTurnSpan({ traceId: "t3", userEntraId: raw });
    span1.end();
    const span2 = startRootTurnSpan({ traceId: "t4", userEntraId: raw });
    span2.end();
    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.attributes["chemclaw.user"]).toBe(
      spans[1]?.attributes["chemclaw.user"],
    );
  });
});
