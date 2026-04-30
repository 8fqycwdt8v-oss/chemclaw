// Tests for withUserContext — verifies SET LOCAL is issued and connection
// is released on both success and throw paths.

import { describe, it, expect } from "vitest";
import { withUserContext } from "../../src/db/with-user-context.js";
import { mockPool } from "../helpers/mock-pg.js";

describe("withUserContext", () => {
  it("issues BEGIN, set_config, COMMIT in order on success", async () => {
    const { pool, client } = mockPool();

    const result = await withUserContext(pool, "user@example.com", async () => {
      return 42;
    });

    expect(result).toBe(42);

    // Query sequence: BEGIN → set_config → COMMIT
    const calls: string[] = client.querySpy.mock.calls.map(
      (c: unknown[]) => (c[0] as string).trim(),
    );
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toMatch(/set_config/);
    expect(calls[2]).toBe("COMMIT");
  });

  it("passes the userEntraId to set_config", async () => {
    const { pool, client } = mockPool();

    await withUserContext(pool, "alice@pharma.example", async () => "ok");

    const setConfigCall = client.querySpy.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("set_config"),
    );
    expect(setConfigCall).toBeDefined();
    // Second argument is the params array; first param is the entra id.
    expect((setConfigCall as unknown[][])[1]).toEqual(["alice@pharma.example"]);
  });

  it("releases the client on success", async () => {
    const { pool, client } = mockPool();
    await withUserContext(pool, "user@test.com", async () => "done");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("issues ROLLBACK and releases on throw, then re-throws", async () => {
    const { pool, client } = mockPool();
    const boom = new Error("something broke");

    await expect(
      withUserContext(pool, "user@test.com", async () => {
        throw boom;
      }),
    ).rejects.toThrow("something broke");

    const calls: string[] = client.querySpy.mock.calls.map(
      (c: unknown[]) => (c[0] as string).trim(),
    );
    expect(calls).toContain("ROLLBACK");
    // Client must still be released even on error.
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not commit when the callback throws", async () => {
    const { pool, client } = mockPool();

    await expect(
      withUserContext(pool, "user@test.com", async () => {
        throw new Error("oops");
      }),
    ).rejects.toThrow();

    const calls: string[] = client.querySpy.mock.calls.map(
      (c: unknown[]) => (c[0] as string).trim(),
    );
    expect(calls).not.toContain("COMMIT");
  });

  it("returns the value produced by the callback", async () => {
    const { pool } = mockPool();
    const value = { answer: 42 };
    const result = await withUserContext(pool, "u", async () => value);
    expect(result).toBe(value);
  });
});
