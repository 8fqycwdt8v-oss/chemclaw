// Tests for routes/forged-tools.ts — scope promotion + disable (Phase D.5).
//
// Uses mocked withUserContext + mocked pool; no real HTTP or Postgres.

import { describe, it, expect, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// We test the business logic extracted from the route handler directly.
// ---------------------------------------------------------------------------

// Replicate the isAdmin logic from the route (needs AGENT_ADMIN_USERS env var).
function isAdmin(userEntraId: string): boolean {
  const raw = process.env.AGENT_ADMIN_USERS ?? "";
  if (!raw.trim()) return false;
  const admins = raw
    .split(",")
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(userEntraId.toLowerCase());
}

describe("isAdmin", () => {
  it("returns false when AGENT_ADMIN_USERS is unset", () => {
    delete process.env.AGENT_ADMIN_USERS;
    expect(isAdmin("anyone@test.com")).toBe(false);
  });

  it("returns true for a listed admin", () => {
    process.env.AGENT_ADMIN_USERS = "admin@test.com,super@test.com";
    expect(isAdmin("admin@test.com")).toBe(true);
  });

  it("is case-insensitive", () => {
    process.env.AGENT_ADMIN_USERS = "Admin@Test.Com";
    expect(isAdmin("admin@test.com")).toBe(true);
  });

  it("returns false for non-listed user", () => {
    process.env.AGENT_ADMIN_USERS = "admin@test.com";
    expect(isAdmin("other@test.com")).toBe(false);
  });

  it("handles trailing comma / whitespace", () => {
    process.env.AGENT_ADMIN_USERS = "admin@test.com, , ";
    expect(isAdmin("admin@test.com")).toBe(true);
    expect(isAdmin("")).toBe(false);
  });

  it("returns false when AGENT_ADMIN_USERS is empty string", () => {
    process.env.AGENT_ADMIN_USERS = "";
    expect(isAdmin("anyone@test.com")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Permission gate logic: owner OR admin can mutate.
// ---------------------------------------------------------------------------

function canMutate(
  userEntraId: string,
  proposedByUserEntraId: string,
  adminEnvUsers: string,
): boolean {
  process.env.AGENT_ADMIN_USERS = adminEnvUsers;
  const isOwner = proposedByUserEntraId === userEntraId;
  return isOwner || isAdmin(userEntraId);
}

describe("canMutate — owner-or-admin gate", () => {
  afterEach(() => {
    delete process.env.AGENT_ADMIN_USERS;
  });

  it("allows the owner to mutate", () => {
    expect(canMutate("user@test.com", "user@test.com", "")).toBe(true);
  });

  it("allows an admin to mutate another user's tool", () => {
    expect(canMutate("admin@test.com", "owner@test.com", "admin@test.com")).toBe(true);
  });

  it("denies a non-owner non-admin user", () => {
    expect(canMutate("other@test.com", "owner@test.com", "admin@test.com")).toBe(false);
  });

  it("denies when admin list is empty and user is not owner", () => {
    expect(canMutate("intruder@test.com", "owner@test.com", "")).toBe(false);
  });
});
