// Post-session-review regression test: process-level signal/error
// handlers must be installed BEFORE the startup work begins, not after
// app.listen() succeeds. The monolithic pre-PR-6 index.ts registered
// SIGINT / SIGTERM / unhandledRejection / uncaughtException at module
// top level — splitting startServer out into bootstrap/start.ts moved
// the registration after app.listen, which left a multi-await window
// where a SIGTERM from k8s would default-exit (no app.close / pool.end)
// and any unhandled rejection during startup would bypass the
// structured logger. The fix hoists registerProcessHandlers to the top
// of startServer; this test pins the ordering so a future refactor
// can't regress it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startServer } from "../../src/bootstrap/start.js";

describe("bootstrap/start.ts — process handler ordering", () => {
  let processOnSpy: ReturnType<typeof vi.spyOn>;
  let captured: { processOnAt: number | null; loadFromDbAt: number | null };
  let counter: number;
  // Cache and restore handlers around the test so we don't leak listeners.
  // Vitest workers re-use the same Node process, so registering SIGINT etc.
  // mutates global state. We snapshot the current listeners and restore
  // them in afterEach.
  let savedListeners: Record<string, ReadonlyArray<(...args: unknown[]) => void>>;

  beforeEach(() => {
    counter = 0;
    captured = { processOnAt: null, loadFromDbAt: null };
    savedListeners = {
      SIGINT: process.listeners("SIGINT").slice(),
      SIGTERM: process.listeners("SIGTERM").slice(),
      unhandledRejection: process.listeners("unhandledRejection").slice(),
      uncaughtException: process.listeners("uncaughtException").slice(),
    };
    processOnSpy = vi.spyOn(process, "on");
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    // Remove any listeners the test added beyond the saved set.
    for (const ev of ["SIGINT", "SIGTERM", "unhandledRejection", "uncaughtException"] as const) {
      const saved = (savedListeners[ev] ?? []) as ReadonlyArray<(...args: unknown[]) => void>;
      const current = process.listeners(ev) as Array<(...args: unknown[]) => void>;
      for (const listener of current) {
        if (!saved.includes(listener)) {
          process.off(ev, listener);
        }
      }
    }
  });

  it("registers SIGTERM/SIGINT BEFORE registry.loadFromDb runs", async () => {
    // Stub the four side-effecting bits so startServer's body still runs
    // its ordering but doesn't actually bind a port or hit a DB.
    const fakeApp = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        debug: vi.fn(),
      },
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const fakeDeps = {
      pool: {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        end: vi.fn().mockResolvedValue(undefined),
      },
      llmProvider: {} as never,
      registry: {
        loadFromDb: vi.fn().mockImplementation(async () => {
          captured.loadFromDbAt = ++counter;
          return await Promise.resolve();
        }),
        size: 0,
        all: vi.fn().mockReturnValue([]),
      },
      promptRegistry: {} as never,
      skillLoader: {
        load: vi.fn(),
        loadFromDb: vi.fn().mockResolvedValue({ count: 0 }),
        size: 0,
      },
      paperclipClient: {} as never,
      shadowEvaluator: {} as never,
    };

    // Track the first time process.on('SIGTERM', ...) gets called. This
    // must be BEFORE registry.loadFromDb runs — that's the invariant the
    // post-session review caught a regression on.
    processOnSpy.mockImplementation((event: string | symbol, _listener: never) => {
      if (event === "SIGTERM" && captured.processOnAt === null) {
        captured.processOnAt = ++counter;
      }
      return process;
    });

    const cfg = {
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: 0,
      AGENT_MODEL: "test",
      AGENT_TOKEN_BUDGET: 1000,
    } as never;

    // The hook loader will throw because we have no real lifecycle wired;
    // catch and ignore — we only care about handler-vs-loadFromDb ordering.
    await startServer(fakeApp as never, cfg, fakeDeps as never).catch(() => {
      /* expected — hook loader fails on stub deps */
    });

    expect(captured.processOnAt).not.toBeNull();
    expect(captured.loadFromDbAt).not.toBeNull();
    // SIGTERM handler must be installed before the first DB-touching await.
    expect(captured.processOnAt!).toBeLessThan(captured.loadFromDbAt!);
  });
});
