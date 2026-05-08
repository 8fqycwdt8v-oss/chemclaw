// Tests for the per-session E2B sandbox cache (acquire / close /
// session_end hook integration).

import { describe, expect, it, vi } from "vitest";
import {
  acquireSessionSandbox,
  closeSessionSandbox,
  enableSessionSandboxCache,
} from "../../../src/core/session-sandbox.js";
import type { SandboxClient, SandboxHandle } from "../../../src/core/sandbox.js";
import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerSessionSandboxCloseHook } from "../../../src/core/hooks/session-sandbox-close.js";
import { makeCtx } from "../../helpers/make-ctx.js";

interface FakeSandboxClient extends SandboxClient {
  createCalls: number;
  closeCalls: number;
}

function fakeClient(): FakeSandboxClient {
  let n = 0;
  const obj: Partial<FakeSandboxClient> = {
    createCalls: 0,
    closeCalls: 0,
    executePython: vi.fn(),
    installPackages: vi.fn(),
    mountReadOnlyFile: vi.fn(),
  };
  obj.createSandbox = vi.fn(async (): Promise<SandboxHandle> => {
    (obj as FakeSandboxClient).createCalls += 1;
    return { id: `sandbox-${++n}`, _raw: {} };
  });
  obj.closeSandbox = vi.fn(async () => {
    (obj as FakeSandboxClient).closeCalls += 1;
  });
  return obj as FakeSandboxClient;
}

describe("acquireSessionSandbox", () => {
  it("falls back to single-use when cache flag not set", async () => {
    const client = fakeClient();
    const ctx = makeCtx();
    const lease1 = await acquireSessionSandbox(ctx, client, "stub-v1");
    const lease2 = await acquireSessionSandbox(ctx, client, "stub-v1");
    expect(client.createCalls).toBe(2);
    expect(lease1.callerOwnsLifecycle).toBe(true);
    expect(lease2.callerOwnsLifecycle).toBe(true);
    // Both sandboxes are distinct handles in single-use mode.
    expect(lease1.handle.id).not.toBe(lease2.handle.id);
  });

  it("reuses one sandbox across calls when cache enabled", async () => {
    const client = fakeClient();
    const ctx = makeCtx();
    enableSessionSandboxCache(ctx);
    const lease1 = await acquireSessionSandbox(ctx, client, "stub-v1");
    const lease2 = await acquireSessionSandbox(ctx, client, "stub-v1");
    expect(client.createCalls).toBe(1);
    expect(lease1.handle.id).toBe(lease2.handle.id);
    expect(lease1.callerOwnsLifecycle).toBe(false);
    expect(lease2.callerOwnsLifecycle).toBe(false);
    // Stub is mounted on the first call, skipped on the second.
    expect(lease1.needsStubMount).toBe(true);
    lease1.recordStubMounted("stub-v1");
    const lease3 = await acquireSessionSandbox(ctx, client, "stub-v1");
    expect(lease3.needsStubMount).toBe(false);
  });

  it("re-mounts when a different stub key is requested on the same sandbox", async () => {
    const client = fakeClient();
    const ctx = makeCtx();
    enableSessionSandboxCache(ctx);
    const a = await acquireSessionSandbox(ctx, client, "stub-A");
    a.recordStubMounted("stub-A");
    const b = await acquireSessionSandbox(ctx, client, "stub-B");
    expect(b.needsStubMount).toBe(true);
    expect(b.handle.id).toBe(a.handle.id);
  });
});

describe("closeSessionSandbox", () => {
  it("is idempotent when no sandbox is cached", async () => {
    const client = fakeClient();
    await closeSessionSandbox(makeCtx(), client);
    expect(client.closeCalls).toBe(0);
  });

  it("closes the cached handle exactly once and clears the slot", async () => {
    const client = fakeClient();
    const ctx = makeCtx();
    enableSessionSandboxCache(ctx);
    await acquireSessionSandbox(ctx, client, "stub-v1");

    await closeSessionSandbox(ctx, client);
    await closeSessionSandbox(ctx, client);
    expect(client.closeCalls).toBe(1);
  });

  it("swallows close errors", async () => {
    const client = fakeClient();
    (client.closeSandbox as unknown) = vi.fn(async () => {
      throw new Error("upstream gone");
    });
    const ctx = makeCtx();
    enableSessionSandboxCache(ctx);
    await acquireSessionSandbox(ctx, client, "stub-v1");
    await expect(closeSessionSandbox(ctx, client)).resolves.toBeUndefined();
  });
});

describe("registerSessionSandboxCloseHook", () => {
  it("closes any cached sandbox when session_end fires", async () => {
    const client = fakeClient();
    const ctx = makeCtx();
    enableSessionSandboxCache(ctx);
    await acquireSessionSandbox(ctx, client, "stub-v1");

    const lifecycle = new Lifecycle();
    registerSessionSandboxCloseHook(lifecycle, client);
    await lifecycle.dispatch("session_end", {
      ctx,
      sessionId: "sess-1",
      finishReason: "stop",
    });
    expect(client.closeCalls).toBe(1);
  });

  it("is a no-op when no sandbox client is wired", async () => {
    const client = fakeClient();
    const ctx = makeCtx();
    enableSessionSandboxCache(ctx);
    await acquireSessionSandbox(ctx, client, "stub-v1");

    const lifecycle = new Lifecycle();
    registerSessionSandboxCloseHook(lifecycle, null);
    await lifecycle.dispatch("session_end", {
      ctx,
      sessionId: "sess-1",
      finishReason: "stop",
    });
    expect(client.closeCalls).toBe(0);
  });
});
