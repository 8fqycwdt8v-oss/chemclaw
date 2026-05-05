// Warm child pool for the Monty runtime.
//
// Pre-spawns up to `size` runner children, watches each for the "ready"
// frame, and hands them out via acquire(). Each child is single-use: after
// the host finishes a run, the child exits, and the pool spawns a
// replacement in the background so the next acquire() finds a warm one.
//
// Why single-use?
//   Monty scripts share a Python namespace if reused. Even if Monty itself
//   resets per-run state, a leak in the runner script (modules cached in
//   sys.modules, mutable defaults) could carry over. Per-run process
//   guarantees a clean slate at the cost of one process spawn per run —
//   the warm pool absorbs that spawn cost outside the request path.
//
// The pool wraps every acquired child in a PrewarmedChildWrapper that
// re-emits the cached "ready" frame when the host attaches its frame
// listener, so the host's wait-for-ready → send-start protocol works
// unchanged. Acquired children look identical to fresh ones from the
// host's perspective.

import { EventEmitter } from "node:events";
import type {
  MontyChild,
  MontyChildEvents,
  MontyChildFactory,
} from "./child-adapter.js";
import type {
  ChildToHostFrameT,
  HostToChildFrameT,
} from "./protocol.js";
import { getLogger } from "../../observability/logger.js";

/**
 * Wraps a pooled child that has already emitted "ready" so the host
 * (which waits for that frame before sending Start) sees it again on the
 * next event-loop tick after attaching its listener. All other events
 * (frame, stderr_line, exit, error) are forwarded transparently from the
 * inner child to wrapper listeners.
 */
class PrewarmedChildWrapper extends EventEmitter implements MontyChild {
  private readyReplayed = false;

  constructor(private readonly inner: MontyChild) {
    super();
    inner.on("frame", (f) => this.emit("frame", f));
    inner.on("stderr_line", (l) => this.emit("stderr_line", l));
    inner.on("exit", (c, s) => this.emit("exit", c, s));
    inner.on("error", (e) => this.emit("error", e));
  }

  send(frame: HostToChildFrameT): void {
    this.inner.send(frame);
  }

  kill(signal?: NodeJS.Signals): void {
    this.inner.kill(signal);
  }

  get alive(): boolean {
    return this.inner.alive;
  }

  override on<K extends keyof MontyChildEvents>(
    event: K,
    listener: MontyChildEvents[K],
  ): this {
    super.on(event, listener as (...args: unknown[]) => void);
    // Replay ready exactly once, when the first frame listener attaches.
    // setImmediate so the listener is fully registered before we emit.
    if (
      event === "frame" &&
      !this.readyReplayed &&
      this.listenerCount("frame") === 1
    ) {
      this.readyReplayed = true;
      setImmediate(() => this.emit("frame", { type: "ready" }));
    }
    return this;
  }

  override off<K extends keyof MontyChildEvents>(
    event: K,
    listener: MontyChildEvents[K],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

interface PooledEntry {
  child: MontyChild;
  readyAt: number;
}

export interface WarmChildPoolOptions {
  factory: MontyChildFactory;
  size: number;
  /** Max time (ms) acquire() waits for a ready child before falling back to a fresh spawn. */
  acquireTimeoutMs?: number;
  /** Max time (ms) the pool waits for a child to emit "ready" before discarding and respawning. */
  readyTimeoutMs?: number;
}

/**
 * Process-lifetime pool of pre-warmed children. Construct once in
 * dependencies.ts (when monty is enabled), shut down on process exit.
 */
export class WarmChildPool {
  private readonly idle: PooledEntry[] = [];
  private readonly waitQueue: Array<(child: MontyChild) => void> = [];
  private destroyed = false;
  private readonly log = getLogger("agent-claw.runtime.monty.pool");

  constructor(private readonly opts: WarmChildPoolOptions) {
    for (let i = 0; i < opts.size; i++) this.spawnOne();
  }

  /**
   * Hand out a ready child. Resolves with a PrewarmedChildWrapper that
   * replays "ready" so the host's protocol works unchanged.
   *
   * If no idle child is available within acquireTimeoutMs, falls back to
   * spawning a fresh child synchronously — slow path, but correctness over
   * latency when the pool is exhausted.
   */
  async acquire(): Promise<MontyChild> {
    if (this.destroyed) {
      throw new Error("WarmChildPool: cannot acquire from a destroyed pool");
    }

    // Hot path — idle child available.
    const entry = this.idle.shift();
    if (entry) {
      this.spawnOne(); // background top-up
      return new PrewarmedChildWrapper(entry.child);
    }

    // Slow path — wait for the next child to become ready, with a timeout
    // fallback that spawns a fresh child synchronously.
    const acquireTimeoutMs = this.opts.acquireTimeoutMs ?? 5_000;
    return await new Promise<MontyChild>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const idx = this.waitQueue.indexOf(resolver);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        // Spawn one synchronously and wrap as a fresh (non-prewarmed)
        // child — i.e. do NOT use PrewarmedChildWrapper, since this child
        // hasn't emitted ready yet. Plain factory output suffices.
        try {
          const fresh = this.opts.factory();
          Promise.resolve(fresh).then(resolve, reject);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }, acquireTimeoutMs);

      const resolver = (child: MontyChild): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(new PrewarmedChildWrapper(child));
      };
      this.waitQueue.push(resolver);
    });
  }

  /** Number of pre-warmed children currently idle. */
  get idleCount(): number {
    return this.idle.length;
  }

  /** Force-terminate all idle children and refuse further acquires. */
  shutdown(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const entry of this.idle) {
      try {
        entry.child.kill();
      } catch {
        // already dead
      }
    }
    this.idle.length = 0;
    // Reject any pending waiters so callers don't hang.
    for (const waiter of this.waitQueue) {
      try {
        // We can't reject from a single-arg resolver — feed a synthetic
        // dead child whose alive=false so the host fails fast.
        waiter(_makeDeadChild());
      } catch {
        // best effort
      }
    }
    this.waitQueue.length = 0;
  }

  private spawnOne(): void {
    if (this.destroyed) return;
    const factoryResult = this.opts.factory();
    Promise.resolve(factoryResult)
      .then((child) => {
        this._attachReadyListener(child);
      })
      .catch((err: unknown) => {
        this.log.warn(
          {
            event: "monty_pool_spawn_failed",
            err: err instanceof Error ? err.message : String(err),
          },
          "Monty pool factory threw — pool size temporarily reduced",
        );
      });
  }

  private _attachReadyListener(child: MontyChild): void {
    if (this.destroyed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      return;
    }

    const readyTimeoutMs = this.opts.readyTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armed = true;

    const onFrame = (frame: ChildToHostFrameT): void => {
      if (frame.type !== "ready" || !armed) return;
      armed = false;
      child.off("frame", onFrame);
      if (timer) clearTimeout(timer);
      this._enqueueReady(child);
    };

    const onExit = (): void => {
      if (!armed) return;
      armed = false;
      if (timer) clearTimeout(timer);
      // Child died before becoming ready; replace it.
      this.spawnOne();
    };

    child.on("frame", onFrame);
    child.on("exit", onExit);

    timer = setTimeout(() => {
      if (!armed) return;
      armed = false;
      this.log.warn(
        { event: "monty_pool_ready_timeout" },
        "child did not emit ready within deadline — killing and respawning",
      );
      try {
        child.kill();
      } catch {
        // ignore
      }
      this.spawnOne();
    }, readyTimeoutMs);
    timer.unref();
  }

  private _enqueueReady(child: MontyChild): void {
    if (this.destroyed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
      return;
    }
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter(child);
    } else {
      this.idle.push({ child, readyAt: Date.now() });
    }
  }
}

/**
 * Synthetic dead child used when the pool is shut down and a waiter
 * can't be resolved with a live one. The host will see `alive === false`
 * and surface a child_crashed outcome to the script caller.
 */
function _makeDeadChild(): MontyChild {
  const ee = new EventEmitter();
  return {
    send() {
      throw new Error("dead child");
    },
    kill() {},
    get alive() {
      return false;
    },
    on(event, listener) {
      ee.on(event, listener as (...args: unknown[]) => void);
      // Defer an immediate exit so the host's exit handler fires.
      if (event === "exit") {
        setImmediate(() => ee.emit("exit", null, null));
      }
      return this;
    },
    off(event, listener) {
      ee.off(event, listener as (...args: unknown[]) => void);
      return this;
    },
  };
}
