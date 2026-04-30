import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetUserHashForTests, hashUser } from "../../src/observability/user-hash.js";

describe("hashUser", () => {
  beforeEach(() => {
    __resetUserHashForTests();
    delete process.env.LOG_USER_SALT;
  });
  afterEach(() => {
    __resetUserHashForTests();
    delete process.env.LOG_USER_SALT;
  });

  it("returns empty string for empty / nullish input", () => {
    expect(hashUser("")).toBe("");
    expect(hashUser(undefined)).toBe("");
    expect(hashUser(null)).toBe("");
  });

  it("returns a 16-char hex prefix", () => {
    const out = hashUser("alice@example.com");
    expect(out).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same input within one salt", () => {
    process.env.LOG_USER_SALT = "fixed-salt";
    __resetUserHashForTests();
    const a = hashUser("alice@example.com");
    const b = hashUser("alice@example.com");
    expect(a).toBe(b);
  });

  it("changes when the salt changes", () => {
    process.env.LOG_USER_SALT = "salt-A";
    __resetUserHashForTests();
    const aWithA = hashUser("alice@example.com");
    process.env.LOG_USER_SALT = "salt-B";
    __resetUserHashForTests();
    const aWithB = hashUser("alice@example.com");
    expect(aWithA).not.toBe(aWithB);
  });

  it("never returns the raw input", () => {
    const raw = "alice@example.com";
    expect(hashUser(raw)).not.toContain("alice");
    expect(hashUser(raw)).not.toContain("@");
  });
});
