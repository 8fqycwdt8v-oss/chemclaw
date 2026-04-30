// core/sandbox.ts — E2B SDK wrapper for programmatic tool calling.
//
// Design:
//   - Wraps the `e2b` Node SDK (Apache 2.0).
//   - All real E2B traffic is gated behind the E2B_API_KEY env var.
//   - Per-execution cap: SANDBOX_MAX_CPU_S=30.
//   - Network egress is disabled by default; enabled only when explicitly requested.
//   - All methods throw SandboxError on failure.

import type { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxHandle {
  /** Opaque identifier — used internally to route calls to the right sandbox. */
  id: string;
  /** The underlying E2B sandbox instance (typed as unknown to avoid import coupling). */
  _raw: unknown;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  /** Paths of files created by the execution (relative to /sandbox). */
  files_created: string[];
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class SandboxError extends Error {
  constructor(
    public readonly phase: "create" | "execute" | "install" | "mount" | "close",
    message: string,
  ) {
    super(`SandboxError[${phase}]: ${message}`);
    this.name = "SandboxError";
  }
}

// ---------------------------------------------------------------------------
// Per-execution cap constants (read from env, with defaults).
// ---------------------------------------------------------------------------

export const SANDBOX_MAX_CPU_S = Number(process.env.SANDBOX_MAX_CPU_S ?? 30);
// SANDBOX_MAX_MEM_MB was previously exported here but never wired into the
// E2B SDK call — the SDK doesn't expose a runtime memory limit hook on
// the current `e2b` package version. Dropped per audit L8 (orphan export);
// add it back together with the SDK call when memory caps are needed.
// Set to "true" to allow forged code to make outbound HTTP. Off by default.
// SANDBOX_ALLOW_NET_EGRESS is the canonical name. SANDBOX_MAX_NET_EGRESS was
// the original (misleading — sounded like a byte cap) and is read as a
// migration fallback so existing deployments don't silently change behavior.
export const SANDBOX_ALLOW_NET_EGRESS =
  process.env.SANDBOX_ALLOW_NET_EGRESS === "true" ||
  process.env.SANDBOX_MAX_NET_EGRESS === "true";

// ---------------------------------------------------------------------------
// Lazy E2B SDK loader — avoids hard import at module level so tests can mock
// the `e2b` module without hitting its SDK constructor.
// ---------------------------------------------------------------------------

interface E2BSdkSandbox {
  create(opts: { apiKey: string; template: string; timeoutMs?: number }): Promise<E2BSandboxInstance>;
}

interface E2BSandboxInstance {
  sandboxId: string;
  filesystem: {
    write(path: string, data: Buffer | string): Promise<void>;
    list(path: string): Promise<{ name: string; isDir: boolean }[]>;
  };
  process: {
    startAndWait(opts: {
      cmd: string;
      envs?: Record<string, string>;
      timeoutMs?: number;
    }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
  kill(): Promise<void>;
}

let _sdkCache: E2BSdkSandbox | null = null;

interface E2BModuleShape {
  Sandbox?: E2BSdkSandbox;
  default?: E2BSdkSandbox | { Sandbox?: E2BSdkSandbox };
}

function isE2BSdkSandbox(x: unknown): x is E2BSdkSandbox {
  if (typeof x !== "object" || x === null) return false;
  if (!("create" in x)) return false;
  return typeof x.create === "function";
}

async function loadSdk(): Promise<E2BSdkSandbox> {
  if (_sdkCache) return _sdkCache;
  try {
    // Dynamic import — keeps the test bundle lightweight and avoids a hard
    // dependency on the e2b package at typecheck time. The real package is
    // installed in production; tests inject a vi.mock("e2b").
    const importer: (spec: string) => Promise<unknown> = (s) =>
      import(/* @vite-ignore */ s);
    const mod = (await importer("e2b")) as E2BModuleShape;
    let sdk: unknown = mod.Sandbox;
    if (!isE2BSdkSandbox(sdk)) {
      sdk = mod.default;
      if (typeof sdk === "object" && sdk !== null && "Sandbox" in sdk) {
        sdk = sdk.Sandbox;
      }
    }
    if (!isE2BSdkSandbox(sdk)) {
      throw new Error("e2b module does not export a Sandbox.create function");
    }
    _sdkCache = sdk;
    return _sdkCache;
  } catch (err) {
    throw new SandboxError("create", `e2b SDK import failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Sandbox client — stateless factory style.
// ---------------------------------------------------------------------------

export interface SandboxClient {
  createSandbox(): Promise<SandboxHandle>;
  executePython(
    handle: SandboxHandle,
    code: string,
    env: Record<string, string>,
    stdin?: string,
    timeoutMs?: number,
  ): Promise<ExecutionResult>;
  installPackages(handle: SandboxHandle, packages: string[]): Promise<void>;
  mountReadOnlyFile(handle: SandboxHandle, source: Buffer, path: string): Promise<void>;
  closeSandbox(handle: SandboxHandle): Promise<void>;
}

// ---------------------------------------------------------------------------
// buildSandboxClient — constructs the real E2B-backed client.
// Tests inject a mock via the factory function below.
// ---------------------------------------------------------------------------

export function buildSandboxClient(cfg: Pick<Config, "E2B_API_KEY" | "E2B_TEMPLATE_ID">): SandboxClient {
  const apiKey = cfg.E2B_API_KEY;
  const template = cfg.E2B_TEMPLATE_ID;

  return {
    async createSandbox(): Promise<SandboxHandle> {
      const sdk = await loadSdk();
      let instance: E2BSandboxInstance;
      try {
        instance = await sdk.create({
          apiKey,
          template,
          timeoutMs: (SANDBOX_MAX_CPU_S + 10) * 1000,
        });
      } catch (err) {
        throw new SandboxError("create", (err as Error).message);
      }
      return { id: instance.sandboxId, _raw: instance };
    },

    async executePython(
      handle: SandboxHandle,
      code: string,
      env: Record<string, string>,
      _stdin?: string,
      timeoutMs = SANDBOX_MAX_CPU_S * 1000,
    ): Promise<ExecutionResult> {
      const instance = handle._raw as E2BSandboxInstance;
      const start = Date.now();

      // Write the code to a temp file inside the sandbox.
      const scriptPath = "/sandbox/_run.py";
      try {
        await instance.filesystem.write(scriptPath, code);
      } catch (err) {
        throw new SandboxError("execute", `filesystem.write failed: ${(err as Error).message}`);
      }

      // Build the command. If net egress is disallowed, we don't set network vars.
      const envs: Record<string, string> = { ...env };
      if (!SANDBOX_ALLOW_NET_EGRESS) {
        // These vars are advisory — actual blocking is enforced at E2B template level.
        envs.CHEMCLAW_NO_NET = "1";
      }

      let result: { exitCode: number; stdout: string; stderr: string };
      try {
        result = await instance.process.startAndWait({
          cmd: `python3 ${scriptPath}`,
          envs,
          timeoutMs,
        });
      } catch (err) {
        throw new SandboxError("execute", `process.startAndWait failed: ${(err as Error).message}`);
      }

      // List files created under /sandbox (best-effort).
      let filesCreated: string[] = [];
      try {
        const listing = await instance.filesystem.list("/sandbox");
        filesCreated = listing
          .filter((f) => !f.isDir && f.name !== "_run.py")
          .map((f) => `/sandbox/${f.name}`);
      } catch {
        // Non-fatal — execution result is still valid.
        filesCreated = [];
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exitCode,
        files_created: filesCreated,
        duration_ms: Date.now() - start,
      };
    },

    async installPackages(handle: SandboxHandle, packages: string[]): Promise<void> {
      if (packages.length === 0) return;
      const instance = handle._raw as E2BSandboxInstance;
      const cmd = `pip install --quiet ${packages.map((p) => JSON.stringify(p)).join(" ")}`;
      try {
        const result = await instance.process.startAndWait({ cmd, timeoutMs: 120_000 });
        if (result.exitCode !== 0) {
          throw new SandboxError(
            "install",
            `pip install failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`,
          );
        }
      } catch (err) {
        if (err instanceof SandboxError) throw err;
        throw new SandboxError("install", (err as Error).message);
      }
    },

    async mountReadOnlyFile(handle: SandboxHandle, source: Buffer, path: string): Promise<void> {
      const instance = handle._raw as E2BSandboxInstance;
      try {
        await instance.filesystem.write(path, source);
      } catch (err) {
        throw new SandboxError("mount", `filesystem.write failed: ${(err as Error).message}`);
      }
    },

    async closeSandbox(handle: SandboxHandle): Promise<void> {
      const instance = handle._raw as E2BSandboxInstance;
      try {
        await instance.kill();
      } catch (err) {
        // Non-fatal — log but don't throw.
         
        console.warn(`SandboxClient: kill() failed for sandbox ${handle.id}: ${(err as Error).message}`);
      }
    },
  };
}
