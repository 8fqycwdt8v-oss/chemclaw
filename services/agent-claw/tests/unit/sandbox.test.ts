// Tests for core/sandbox.ts — E2B SDK wrapper.
// All E2B SDK interactions are fully mocked; no real billing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildSandboxClient,
  SandboxError,
  SANDBOX_MAX_CPU_S,
  SANDBOX_MAX_MEM_MB,
} from "../../src/core/sandbox.js";

// ---------------------------------------------------------------------------
// Mock the E2B SDK module.
// ---------------------------------------------------------------------------

const mockKill = vi.fn().mockResolvedValue(undefined);
const mockWrite = vi.fn().mockResolvedValue(undefined);
const mockList = vi.fn().mockResolvedValue([]);
const mockStartAndWait = vi.fn().mockResolvedValue({
  exitCode: 0,
  stdout: "hello sandbox",
  stderr: "",
});

const mockSandboxId = "test-sandbox-abc123";
const mockInstance = {
  sandboxId: mockSandboxId,
  filesystem: { write: mockWrite, list: mockList },
  process: { startAndWait: mockStartAndWait },
  kill: mockKill,
};

const mockCreate = vi.fn().mockResolvedValue(mockInstance);
const mockSandboxClass = { create: mockCreate };

vi.mock("e2b", () => ({
  Sandbox: mockSandboxClass,
}));

// ---------------------------------------------------------------------------
// Shared test setup.
// ---------------------------------------------------------------------------

const stubCfg = {
  E2B_API_KEY: "test-key",
  E2B_TEMPLATE_ID: "python-3-11",
};

function makeClient() {
  return buildSandboxClient(stubCfg);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreate.mockResolvedValue(mockInstance);
  mockStartAndWait.mockResolvedValue({ exitCode: 0, stdout: "hello", stderr: "" });
  mockList.mockResolvedValue([]);
  mockKill.mockResolvedValue(undefined);
  mockWrite.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSandboxClient — createSandbox", () => {
  it("returns a handle with the sandbox id from E2B", async () => {
    const client = makeClient();
    const handle = await client.createSandbox();
    expect(handle.id).toBe(mockSandboxId);
    expect(handle._raw).toBe(mockInstance);
  });

  it("throws SandboxError when E2B create() rejects", async () => {
    mockCreate.mockRejectedValueOnce(new Error("quota exceeded"));
    const client = makeClient();
    await expect(client.createSandbox()).rejects.toThrow("quota exceeded");
  });
});

describe("buildSandboxClient — executePython", () => {
  it("writes code to /sandbox/_run.py and starts a process", async () => {
    const client = makeClient();
    const handle = await client.createSandbox();
    const result = await client.executePython(handle, 'print("hi")', {});
    expect(mockWrite).toHaveBeenCalledWith("/sandbox/_run.py", 'print("hi")');
    expect(mockStartAndWait).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "python3 /sandbox/_run.py" }),
    );
    expect(result.stdout).toBe("hello");
    expect(result.exit_code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("propagates env vars to the sandbox process", async () => {
    const client = makeClient();
    const handle = await client.createSandbox();
    await client.executePython(handle, "pass", { MY_VAR: "42" });
    const call = mockStartAndWait.mock.calls[0]![0] as { envs: Record<string, string> };
    expect(call.envs.MY_VAR).toBe("42");
  });

  it("includes files_created in the result (excluding _run.py)", async () => {
    mockList.mockResolvedValueOnce([
      { name: "_run.py", isDir: false },
      { name: "output.csv", isDir: false },
    ]);
    const client = makeClient();
    const handle = await client.createSandbox();
    const result = await client.executePython(handle, "pass", {});
    expect(result.files_created).toEqual(["/sandbox/output.csv"]);
  });

  it("throws SandboxError when filesystem.write fails", async () => {
    mockWrite.mockRejectedValueOnce(new Error("disk full"));
    const client = makeClient();
    const handle = await client.createSandbox();
    await expect(client.executePython(handle, "pass", {})).rejects.toThrow(SandboxError);
  });

  it("throws SandboxError when process.startAndWait fails", async () => {
    mockWrite.mockResolvedValue(undefined);
    mockStartAndWait.mockRejectedValueOnce(new Error("timeout"));
    const client = makeClient();
    const handle = await client.createSandbox();
    await expect(client.executePython(handle, "pass", {})).rejects.toThrow(SandboxError);
  });
});

describe("buildSandboxClient — installPackages", () => {
  it("no-ops when packages list is empty", async () => {
    const client = makeClient();
    const handle = await client.createSandbox();
    await client.installPackages(handle, []);
    // startAndWait not called for install.
    expect(mockStartAndWait).not.toHaveBeenCalled();
  });

  it("runs pip install for non-empty package list", async () => {
    const client = makeClient();
    const handle = await client.createSandbox();
    await client.installPackages(handle, ["numpy", "pandas"]);
    const call = mockStartAndWait.mock.calls[0]![0] as { cmd: string };
    expect(call.cmd).toContain("pip install");
    expect(call.cmd).toContain("numpy");
    expect(call.cmd).toContain("pandas");
  });

  it("throws SandboxError when pip exits non-zero", async () => {
    mockStartAndWait.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "package not found" });
    const client = makeClient();
    const handle = await client.createSandbox();
    await expect(client.installPackages(handle, ["nonexistent-pkg"])).rejects.toThrow(SandboxError);
  });
});

describe("buildSandboxClient — mountReadOnlyFile", () => {
  it("writes a Buffer to the given path", async () => {
    const client = makeClient();
    const handle = await client.createSandbox();
    const buf = Buffer.from("print('hello')", "utf-8");
    await client.mountReadOnlyFile(handle, buf, "/sandbox/chemclaw/__init__.py");
    expect(mockWrite).toHaveBeenCalledWith("/sandbox/chemclaw/__init__.py", buf);
  });

  it("throws SandboxError when write fails", async () => {
    mockWrite.mockRejectedValueOnce(new Error("permissions denied"));
    const client = makeClient();
    const handle = await client.createSandbox();
    const buf = Buffer.from("code");
    await expect(
      client.mountReadOnlyFile(handle, buf, "/sandbox/chemclaw/__init__.py"),
    ).rejects.toThrow(SandboxError);
  });
});

describe("buildSandboxClient — closeSandbox", () => {
  it("calls instance.kill()", async () => {
    const client = makeClient();
    const handle = await client.createSandbox();
    await client.closeSandbox(handle);
    expect(mockKill).toHaveBeenCalledOnce();
  });

  it("does not throw when kill() rejects (non-fatal cleanup)", async () => {
    mockKill.mockRejectedValueOnce(new Error("already dead"));
    const client = makeClient();
    const handle = await client.createSandbox();
    // Should not throw.
    await expect(client.closeSandbox(handle)).resolves.toBeUndefined();
  });
});

describe("module-level constants", () => {
  it("exports SANDBOX_MAX_CPU_S as a positive number", () => {
    expect(SANDBOX_MAX_CPU_S).toBeGreaterThan(0);
  });

  it("exports SANDBOX_MAX_MEM_MB as a positive number", () => {
    expect(SANDBOX_MAX_MEM_MB).toBeGreaterThan(0);
  });
});
