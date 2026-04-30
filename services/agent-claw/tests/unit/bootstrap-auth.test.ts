// review-v2 cycle-2: pin the security-critical contract for
// setupAuthAndErrorHandler. The post-PR-46 split moved this code from
// the monolithic index.ts into bootstrap/auth.ts; a regression that
// silently treats production missing-x-user-entra-id as the dev user
// would be a security incident. These tests assert:
//
//   1. dev mode prefers x-dev-user-entra-id, then CHEMCLAW_DEV_USER_EMAIL.
//   2. production REQUIRES x-user-entra-id; missing → throws MissingUserError.
//   3. setErrorHandler maps MissingUserError → 401, not the default 500.
//   4. Other errors preserve statusCode and expose detail only in dev.

import { describe, it, expect, vi } from "vitest";
import { setupAuthAndErrorHandler } from "../../src/bootstrap/auth.js";

function makeAppStub() {
  let errorHandler: ((err: unknown, req: unknown, reply: unknown) => unknown) | null = null;
  const app = {
    setErrorHandler: vi.fn().mockImplementation((fn: typeof errorHandler) => {
      errorHandler = fn;
    }),
    get errorHandler() { return errorHandler; },
  };
  return app;
}

function makeReq(headers: Record<string, string | undefined> = {}) {
  return { headers, log: { error: vi.fn(), warn: vi.fn() } };
}

function makeReply() {
  const code = vi.fn();
  const send = vi.fn();
  const reply = { code: vi.fn(), send: vi.fn() };
  // chainable: code(...).send(...) returns reply for chaining
  reply.code = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  void code; void send;
  return reply;
}

describe("setupAuthAndErrorHandler — getUser (production)", () => {
  it("REQUIRES x-user-entra-id and throws MissingUserError when absent", () => {
    const app = makeAppStub();
    const cfg = { CHEMCLAW_DEV_MODE: false } as never;
    const getUser = setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({}); // no x-user-entra-id

    expect(() => getUser(req as never)).toThrow(/missing x-user-entra-id/i);
  });

  it("returns the x-user-entra-id header value in production", () => {
    const app = makeAppStub();
    const cfg = { CHEMCLAW_DEV_MODE: false } as never;
    const getUser = setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({ "x-user-entra-id": "alice@x" });

    expect(getUser(req as never)).toBe("alice@x");
  });

  it("does NOT fall through to dev-user when CHEMCLAW_DEV_MODE is false (security regression guard)", () => {
    const app = makeAppStub();
    const cfg = {
      CHEMCLAW_DEV_MODE: false,
      CHEMCLAW_DEV_USER_EMAIL: "should-not-be-used@x",
    } as never;
    const getUser = setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({ "x-dev-user-entra-id": "should-not-be-used@x" });

    // Even with the dev header set, production must reject — this is the
    // security contract that the missing-header path is fail-closed.
    expect(() => getUser(req as never)).toThrow(/missing x-user-entra-id/i);
  });
});

describe("setupAuthAndErrorHandler — getUser (dev mode)", () => {
  it("prefers x-dev-user-entra-id when set", () => {
    const app = makeAppStub();
    const cfg = {
      CHEMCLAW_DEV_MODE: true,
      CHEMCLAW_DEV_USER_EMAIL: "fallback@x",
    } as never;
    const getUser = setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({ "x-dev-user-entra-id": "alice@x" });

    expect(getUser(req as never)).toBe("alice@x");
  });

  it("falls back to CHEMCLAW_DEV_USER_EMAIL when x-dev-user-entra-id is absent", () => {
    const app = makeAppStub();
    const cfg = {
      CHEMCLAW_DEV_MODE: true,
      CHEMCLAW_DEV_USER_EMAIL: "default-dev@x",
    } as never;
    const getUser = setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({});

    expect(getUser(req as never)).toBe("default-dev@x");
  });

  it("falls back to CHEMCLAW_DEV_USER_EMAIL when x-dev-user-entra-id is the empty string", () => {
    const app = makeAppStub();
    const cfg = {
      CHEMCLAW_DEV_MODE: true,
      CHEMCLAW_DEV_USER_EMAIL: "default-dev@x",
    } as never;
    const getUser = setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({ "x-dev-user-entra-id": "" });

    expect(getUser(req as never)).toBe("default-dev@x");
  });
});

describe("setupAuthAndErrorHandler — error handler mapping", () => {
  it("maps MissingUserError → 401 with unauthenticated envelope", () => {
    const app = makeAppStub();
    const cfg = { CHEMCLAW_DEV_MODE: false } as never;
    const getUser = setupAuthAndErrorHandler(app as never, cfg);
    expect(app.errorHandler).not.toBeNull();

    // Simulate an unauthenticated request reaching the route.
    const req = makeReq({});
    const reply = makeReply();
    let thrown: unknown;
    try { getUser(req as never); } catch (err) { thrown = err; }
    expect(thrown).toBeDefined();

    app.errorHandler!(thrown, req, reply);
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({
      error: "unauthenticated",
      detail: "x-user-entra-id header is required",
    });
  });

  it("non-MissingUserError preserves statusCode (production hides detail)", () => {
    const app = makeAppStub();
    const cfg = { CHEMCLAW_DEV_MODE: false } as never;
    setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({});
    const reply = makeReply();
    const err = Object.assign(new Error("boom — internal detail"), { statusCode: 503 });

    app.errorHandler!(err, req, reply);
    expect(reply.code).toHaveBeenCalledWith(503);
    // In production, detail must be undefined (not "boom — internal detail").
    expect(reply.send).toHaveBeenCalledWith({
      error: "internal",
      detail: undefined,
    });
  });

  it("non-MissingUserError exposes detail in dev mode", () => {
    const app = makeAppStub();
    const cfg = { CHEMCLAW_DEV_MODE: true } as never;
    setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({});
    const reply = makeReply();
    const err = Object.assign(new Error("boom — dev detail"), { statusCode: 503 });

    app.errorHandler!(err, req, reply);
    expect(reply.send).toHaveBeenCalledWith({
      error: "internal",
      detail: "boom — dev detail",
    });
  });

  it("error without statusCode defaults to 500", () => {
    const app = makeAppStub();
    const cfg = { CHEMCLAW_DEV_MODE: false } as never;
    setupAuthAndErrorHandler(app as never, cfg);
    const req = makeReq({});
    const reply = makeReply();
    const err = new Error("no statusCode here");

    app.errorHandler!(err, req, reply);
    expect(reply.code).toHaveBeenCalledWith(500);
  });
});
