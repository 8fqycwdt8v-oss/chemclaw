import { describe, expect, it } from "vitest";

import { runWithRequestContext } from "../../src/core/request-context.js";
import { logContextFields } from "../../src/observability/log-context.js";

describe("logContextFields", () => {
  it("returns an empty object outside a request context", () => {
    const fields = logContextFields();
    expect(fields).toEqual({});
  });

  it("populates request_id / session_id / user inside a context", async () => {
    await runWithRequestContext(
      {
        userEntraId: "alice@example.com",
        sessionId: "sess-123",
        requestId: "req-abc",
      },
      async () => {
        const fields = logContextFields();
        expect(fields.request_id).toBe("req-abc");
        expect(fields.session_id).toBe("sess-123");
        // Hashed, never raw.
        expect(fields.user).toMatch(/^[0-9a-f]{16}$/);
        expect(fields.user).not.toContain("alice");
      },
    );
  });

  it("omits requestId / sessionId / user fields when not set", async () => {
    await runWithRequestContext({ userEntraId: "" }, async () => {
      const fields = logContextFields();
      expect(fields.request_id).toBeUndefined();
      expect(fields.session_id).toBeUndefined();
      expect(fields.user).toBeUndefined();
    });
  });

  it("propagates fields across async awaits", async () => {
    await runWithRequestContext(
      { userEntraId: "bob@example.com", sessionId: "sess-x", requestId: "req-y" },
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        const fields = logContextFields();
        expect(fields.request_id).toBe("req-y");
        expect(fields.session_id).toBe("sess-x");
      },
    );
  });

  it("does not include trace_id when no OTel span is active", () => {
    const fields = logContextFields();
    expect(fields.trace_id).toBeUndefined();
  });
});
