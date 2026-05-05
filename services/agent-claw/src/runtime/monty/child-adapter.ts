// Monty child adapter — abstracts the process boundary between the host
// and the Monty interpreter.
//
// The default adapter spawns an external binary (configured via
// `monty.binary_path`) and speaks the line-delimited JSON-RPC protocol
// from protocol.ts over its stdio. Tests substitute a FakeChildAdapter
// that loops back the protocol in-process, which lets us exercise the
// bridge / pool / host without depending on the Monty binary being
// installed.
//
// Two design notes:
//   1. Crash isolation — a Rust panic in Monty exits the child with a
//      non-zero code; the adapter surfaces that as `onExit` and the host
//      reports a structured tool error. The parent stays up.
//   2. AsyncLocalStorage — the bridge runs in the parent process, so
//      `getRequestContext()` (used by postJson / withUserContext) is
//      naturally in scope when each external_function returns. The child
//      never sees the user identity or the MCP JWT.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { decodeFrame, encodeFrame, type ChildToHostFrameT, type HostToChildFrameT } from "./protocol.js";

/**
 * Lifecycle events emitted by an adapter.
 *
 * - "frame": one valid child→host frame parsed off stdout.
 * - "stderr_line": one raw line from the child's stderr; useful for surfacing
 *   panics / startup errors that fall outside the JSON-RPC framing.
 * - "exit": the child exited; carries the exit code (or null on signal).
 * - "error": adapter-level failure (spawn failed, write failed); fatal —
 *   the host should treat the child as dead.
 */
export interface MontyChildEvents {
  frame: (frame: ChildToHostFrameT) => void;
  stderr_line: (line: string) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  error: (err: Error) => void;
}

export interface MontyChild {
  send(frame: HostToChildFrameT): void;
  /** Force-terminate the child. Used when wall-time exceeds limit. */
  kill(signal?: NodeJS.Signals): void;
  /** True until the child exits. */
  readonly alive: boolean;
  on<K extends keyof MontyChildEvents>(event: K, listener: MontyChildEvents[K]): this;
  off<K extends keyof MontyChildEvents>(event: K, listener: MontyChildEvents[K]): this;
}

export interface SubprocessAdapterOptions {
  /** Path to the Monty runner binary (or python3 if running the bundled runner). */
  binaryPath: string;
  /** Argv to pass after the binary path. */
  args?: string[];
  /** Environment variables. Defaults to the parent's env. */
  env?: NodeJS.ProcessEnv;
  /** Working directory. */
  cwd?: string;
}

/**
 * Default adapter — spawns the configured Monty runner as a child process
 * and speaks JSON-RPC over its stdio.
 *
 * Stdout framing: line-delimited JSON. We buffer chunks across reads so a
 * frame split across two `data` events still parses.
 *
 * Stderr framing: pass-through to `stderr_line` events. The child should
 * keep stderr quiet under normal operation; anything that lands here is
 * treated as a diagnostic the host may surface verbatim.
 */
export class SubprocessChildAdapter extends EventEmitter implements MontyChild {
  private child: ChildProcess | null = null;
  private _alive = false;
  private stdoutBuf = "";
  private stderrBuf = "";

  constructor(private readonly opts: SubprocessAdapterOptions) {
    super();
  }

  get alive(): boolean {
    return this._alive;
  }

  /**
   * Spawn the child. Throws synchronously if spawn fails immediately;
   * an async spawn failure surfaces as an "error" event followed by "exit".
   */
  start(): void {
    const child = spawn(this.opts.binaryPath, this.opts.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.opts.env,
      cwd: this.opts.cwd,
    });
    this.child = child;
    this._alive = true;

    // stdio: ["pipe", "pipe", "pipe"] above guarantees stdout/stderr/stdin
    // are non-null Readable/Writable streams.
    const stdout = child.stdout;
    const stderr = child.stderr;

    stdout.setEncoding("utf-8");
    stdout.on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
      let nl: number;
      while ((nl = this.stdoutBuf.indexOf("\n")) !== -1) {
        const line = this.stdoutBuf.slice(0, nl);
        this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
        const frame = decodeFrame(line);
        if (frame) this.emit("frame", frame);
      }
    });

    stderr.setEncoding("utf-8");
    stderr.on("data", (chunk: string) => {
      this.stderrBuf += chunk;
      let nl: number;
      while ((nl = this.stderrBuf.indexOf("\n")) !== -1) {
        const line = this.stderrBuf.slice(0, nl);
        this.stderrBuf = this.stderrBuf.slice(nl + 1);
        if (line.length > 0) this.emit("stderr_line", line);
      }
    });

    child.on("error", (err) => {
      this._alive = false;
      this.emit("error", err);
    });

    child.on("exit", (code, signal) => {
      this._alive = false;
      // Drain remaining buffer fragments — a child that exits without a
      // trailing newline still gave us frames we should surface.
      if (this.stdoutBuf.length > 0) {
        const frame = decodeFrame(this.stdoutBuf);
        if (frame) this.emit("frame", frame);
        this.stdoutBuf = "";
      }
      if (this.stderrBuf.length > 0) {
        this.emit("stderr_line", this.stderrBuf);
        this.stderrBuf = "";
      }
      this.emit("exit", code, signal);
    });
  }

  send(frame: HostToChildFrameT): void {
    if (!this.child || !this._alive) {
      throw new Error("SubprocessChildAdapter.send: child is not alive");
    }
    const stdin = this.child.stdin;
    if (!stdin) {
      throw new Error("SubprocessChildAdapter.send: child stdin not piped");
    }
    const ok = stdin.write(encodeFrame(frame));
    if (!ok) {
      // Backpressure — drain before next write. We surface the wait via
      // the once("drain") hook so callers can stay synchronous.
      stdin.once("drain", () => {});
    }
  }

  kill(signal: NodeJS.Signals = "SIGKILL"): void {
    if (this.child && this._alive) {
      this.child.kill(signal);
    }
  }

  // Re-typed event helpers so TypeScript callers get the typed listener
  // signatures from MontyChildEvents. The runtime just delegates to
  // EventEmitter; we override only for the type narrowing.
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

/**
 * Factory signature consumed by the pool / host. Either synchronous (the
 * default subprocess factory) or asynchronous (the pool's acquire path,
 * which may need to wait for a child to become ready).
 */
export type MontyChildFactory = () => MontyChild | Promise<MontyChild>;

/**
 * Default factory — builds a SubprocessChildAdapter from the host's options.
 * The pool calls .start() on the returned child before handing it out.
 */
export function defaultChildFactory(opts: SubprocessAdapterOptions): MontyChildFactory {
  return () => {
    const child = new SubprocessChildAdapter(opts);
    child.start();
    return child;
  };
}
