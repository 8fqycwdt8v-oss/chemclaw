// Verifies the perf optimisation in `observability/log-context.ts`:
// when RequestContext.userHash is set, the mixin reads it directly
// instead of calling hashUser() on every log emission.

import { describe, expect, it, vi } from "vitest";

import { runWithRequestContext } from "../../src/core/request-context.js";
import { logContextFields } from "../../src/observability/log-context.js";
import * as userHashModule from "../../src/observability/user-hash.js";

describe("log-context userHash precompute", () => {
  it("uses precomputed userHash without calling hashUser", async () => {
    const spy = vi.spyOn(userHashModule, "hashUser");
    spy.mockClear();
    await runWithRequestContext(
      {
        userEntraId: "alice@example.com",
        userHash: "deadbeefcafebabe",
      },
      async () => {
        // Multiple emissions should all read the cached value.
        const f1 = logContextFields();
        const f2 = logContextFields();
        const f3 = logContextFields();
        expect(f1.user).toBe("deadbeefcafebabe");
        expect(f2.user).toBe("deadbeefcafebabe");
        expect(f3.user).toBe("deadbeefcafebabe");
      },
    );
    // Zero hashUser calls — the cached value is returned verbatim.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("falls back to live hashUser when userHash is absent", async () => {
    await runWithRequestContext(
      { userEntraId: "alice@example.com" },
      async () => {
        const fields = logContextFields();
        // Falls through to the live path; result is a real 16-hex hash.
        expect(fields.user).toMatch(/^[0-9a-f]{16}$/);
      },
    );
  });
});
