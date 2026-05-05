// Warm child pool tests — verify pre-spawn, ready-detection, replay-on-acquire,
// replacement after death, and the timeout fallback.

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { WarmChildPool } from "../../../../src/runtime/monty/pool.js";
import { MontyHost } from "../../../../src/runtime/monty/host.js";
import { Lifecycle } from "../../../../src/core/lifecycle.js";
import type {
  MontyChild,
  MontyChildEvents,
  MontyChildFactory,
} from "../../../../src/runtime/monty/child-adapter.js";
import type {
  ChildToHostFrameT,
  HostToChildFrameT,
} from "../../../../src/runtime/monty/protocol.js";
import { makeCtx } from "../../../helpers/make-ctx.js";

interface FakeChildBehavior {
  /** Delay (ms) before emitting ready. Default 0 (next tick). */
  readyDelayMs?: number;
  /** If true, never emit ready — used to test ready-timeout. */
  neverReady?: boolean;
  /** If true, exit immediately without ready — used to test crash replacement. */
  crashBeforeReady?: boolean;
  /** Custom reaction to a Start frame; default is to emit a result with x=1. */
  react?: (
    frame: HostToChildFrameT,
    emit: (frame: ChildToHostFrameT) => void,
    kill: () => void,
  ) => void;
}

class FakeChild extends EventEmitter implements MontyChild {
  private _alive = true;

  constructor(private readonly behavior: FakeChildBehavior) {
    super();
    if (behavior.crashBeforeReady) {
      setImmediate(() => this.kill());
      return;
    }
    if (behavior.neverReady) return;
    setTimeout(
      () => {
        if (this._alive) this.emit("frame", { type: "ready" });
      },
      behavior.readyDelayMs ?? 0,
    );
  }

  send(frame: HostToChildFrameT): void {
    if (!this._alive) return;
    setImmediate(() => {
      const reactor =
        this.behavior.react ??
        ((f, emit) => {
          if (f.type === "start") {
            emit({ type: "result", run_id: f.run_id, outputs: { x: 1 } });
          }
        });
      reactor(frame, (f) => this._alive && this.emit("frame", f), () => this.kill());
    });
  }

  kill(): void {
    if (!this._alive) return;
    this._alive = false;
    setImmediate(() => this.emit("exit", 0, null));
  }

  get alive(): boolean {
    return this._alive;
  }

  override on<K extends keyof MontyChildEvents>(
    event: K,
    listener: MontyChildEvents[K],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof MontyChildEvents>(
    event: K,
    listener: MontyChildEvents[K],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

function fakeFactory(behavior: FakeChildBehavior = {}): MontyChildFactory {
  return () => new FakeChild(behavior);
}

const baseRunOpts = {
  runId: "r1",
  script: "noop",
  allowedTools: [],
  inputs: {},
  expectedOutputs: ["x"],
  wallTimeMs: 5_000,
  maxExternalCalls: 0,
  ctx: makeCtx(),
};

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
  pollMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("waitFor: predicate never became true");
}

describe("WarmChildPool", () => {
  it("pre-spawns size children and marks them idle as they emit ready", async () => {
    const pool = new WarmChildPool({ factory: fakeFactory(), size: 3 });
    try {
      await waitFor(() => pool.idleCount === 3);
      expect(pool.idleCount).toBe(3);
    } finally {
      pool.shutdown();
    }
  });

  it("acquire() returns a wrapped child that replays ready when the host listens", async () => {
    const pool = new WarmChildPool({ factory: fakeFactory(), size: 1 });
    try {
      await waitFor(() => pool.idleCount === 1);
      const child = await pool.acquire();
      let sawReady = false;
      child.on("frame", (f) => {
        if (f.type === "ready") sawReady = true;
      });
      await waitFor(() => sawReady);
      expect(sawReady).toBe(true);
    } finally {
      pool.shutdown();
    }
  });

  it("a top-up child spawns after an acquire", async () => {
    const pool = new WarmChildPool({ factory: fakeFactory(), size: 2 });
    try {
      await waitFor(() => pool.idleCount === 2);
      await pool.acquire();
      expect(pool.idleCount).toBe(1);
      // Top-up should bring it back to 2 within ~10ms.
      await waitFor(() => pool.idleCount === 2);
    } finally {
      pool.shutdown();
    }
  });

  it("replaces children that crash before becoming ready", async () => {
    let spawnCount = 0;
    const factory: MontyChildFactory = () => {
      spawnCount++;
      // First two crash, third succeeds.
      if (spawnCount <= 2) return new FakeChild({ crashBeforeReady: true });
      return new FakeChild({});
    };
    const pool = new WarmChildPool({ factory, size: 1 });
    try {
      // Wait for a ready child to emerge despite two crashes.
      await waitFor(() => pool.idleCount === 1, 2_000);
      expect(spawnCount).toBeGreaterThanOrEqual(3);
    } finally {
      pool.shutdown();
    }
  });

  it("acquire() falls back to a fresh factory spawn when no child is ready in time", async () => {
    let spawnCount = 0;
    const factory: MontyChildFactory = () => {
      spawnCount++;
      // First call (pool's pre-spawn) never emits ready — pool stays empty.
      // Subsequent calls (the fallback) emit ready normally.
      if (spawnCount === 1) return new FakeChild({ neverReady: true });
      return new FakeChild({});
    };
    const pool = new WarmChildPool({
      factory,
      size: 1,
      acquireTimeoutMs: 50,
    });
    try {
      const child = await pool.acquire();
      expect(child).toBeDefined();
      expect(spawnCount).toBeGreaterThan(1); // fallback spawn happened
    } finally {
      pool.shutdown();
    }
  });

  it("end-to-end: MontyHost runs against a pool-wrapped child and gets a result", async () => {
    const pool = new WarmChildPool({ factory: fakeFactory(), size: 1 });
    const lifecycle = new Lifecycle();
    try {
      await waitFor(() => pool.idleCount === 1);
      const host = new MontyHost({
        childFactory: () => pool.acquire(),
        registry: { get: () => undefined },
        lifecycle,
      });
      const result = await host.run(baseRunOpts);
      expect(result.outcome.kind).toBe("ok");
      if (result.outcome.kind === "ok") {
        expect(result.outcome.outputs).toEqual({ x: 1 });
      }
    } finally {
      pool.shutdown();
    }
  });

  it("shutdown() refuses subsequent acquires", async () => {
    const pool = new WarmChildPool({ factory: fakeFactory(), size: 1 });
    pool.shutdown();
    await expect(pool.acquire()).rejects.toThrow(/destroyed pool/);
  });
});
