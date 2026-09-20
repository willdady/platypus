import { describe, it, expect } from "vitest";
import { seedDb, type Row } from "../test-utils.ts";
import {
  resolveOrgMembership,
  resolveWorkspaceAccess,
  type Database,
} from "./authorization.ts";

/**
 * The Drizzle stand-in these tests query: `seedDb()` from `test-utils.ts`, the
 * one fake executor the suite shares, seeded with the two tables
 * {@link resolveOrgMembership} and {@link resolveWorkspaceAccess} read, under
 * the Postgres names it keys rows by.
 *
 * Unlike the chainable `mockDb` — whose `.where()` throws its argument away —
 * this executor interprets the condition a query builds, so a query that
 * dropped a column from its `and(...)` (e.g. matching on `userId` alone)
 * filters the fixture rows incorrectly and the test fails.
 */
const fakeDb = (tables: { organizationMember: Row[]; workspace: Row[] }) =>
  seedDb({
    organization_member: tables.organizationMember,
    workspace: tables.workspace,
  }).handle as Database;

describe("resolveOrgMembership", () => {
  it("grants a super admin without touching the database, even with no orgId", async () => {
    const db = fakeDb({ organizationMember: [], workspace: [] });

    const access = await resolveOrgMembership(
      db,
      { id: "admin-1", role: "admin" },
      undefined,
    );

    expect(access).toEqual({
      allowed: true,
      membership: { role: "admin", isSuperAdmin: true },
    });
  });

  it("denies org-id-required for a non-super-admin with no orgId", async () => {
    const db = fakeDb({ organizationMember: [], workspace: [] });

    const access = await resolveOrgMembership(
      db,
      { id: "u1", role: "user" },
      undefined,
    );

    expect(access).toEqual({ allowed: false, reason: "org-id-required" });
  });

  it("denies not-a-member when no membership row matches both userId and organizationId", async () => {
    // Same user, different org — a query keyed on userId alone would wrongly match this.
    const db = fakeDb({
      organizationMember: [
        { user_id: "u1", organization_id: "org-2", role: "member" },
      ],
      workspace: [],
    });

    const access = await resolveOrgMembership(
      db,
      { id: "u1", role: "user" },
      "org-1",
    );

    expect(access).toEqual({ allowed: false, reason: "not-a-member" });
  });

  it("grants membership when both userId and organizationId match", async () => {
    const db = fakeDb({
      organizationMember: [
        { user_id: "u1", organization_id: "org-1", role: "member" },
      ],
      workspace: [],
    });

    const access = await resolveOrgMembership(
      db,
      { id: "u1", role: "user" },
      "org-1",
    );

    expect(access).toEqual({
      allowed: true,
      membership: { user_id: "u1", organization_id: "org-1", role: "member" },
    });
  });

  it("denies insufficient-role when the member's role is not in requiredRoles", async () => {
    const db = fakeDb({
      organizationMember: [
        { user_id: "u1", organization_id: "org-1", role: "member" },
      ],
      workspace: [],
    });

    const access = await resolveOrgMembership(
      db,
      { id: "u1", role: "user" },
      "org-1",
      ["admin"],
    );

    expect(access).toEqual({ allowed: false, reason: "insufficient-role" });
  });

  it("grants when the member's role is in requiredRoles", async () => {
    const db = fakeDb({
      organizationMember: [
        { user_id: "u1", organization_id: "org-1", role: "admin" },
      ],
      workspace: [],
    });

    const access = await resolveOrgMembership(
      db,
      { id: "u1", role: "user" },
      "org-1",
      ["admin"],
    );

    expect(access.allowed).toBe(true);
  });
});

describe("resolveWorkspaceAccess", () => {
  it("denies not-found when no workspace exists with this id", async () => {
    const db = fakeDb({ organizationMember: [], workspace: [] });

    const access = await resolveWorkspaceAccess(
      db,
      { id: "u1", role: "user" },
      { role: "member" } as never,
      "org-1",
      "ws-1",
    );

    expect(access).toEqual({ allowed: false, reason: "not-found" });
  });

  it("denies cross-org when the workspace belongs to a different organization", async () => {
    // Fixture rows carry camelCase keys, matching what a real Drizzle result
    // row looks like — `resolveWorkspaceAccess` reads `ws.organizationId` /
    // `ws.ownerId` directly, unlike the eq()/and() filtering above.
    const db = fakeDb({
      organizationMember: [],
      workspace: [{ id: "ws-1", organizationId: "org-2", ownerId: "u1" }],
    });

    const access = await resolveWorkspaceAccess(
      db,
      { id: "u1", role: "user" },
      { role: "admin" } as never,
      "org-1",
      "ws-1",
    );

    expect(access).toEqual({ allowed: false, reason: "cross-org" });
  });

  it("denies no-access to a non-owning, non-admin member", async () => {
    const db = fakeDb({
      organizationMember: [],
      workspace: [
        { id: "ws-1", organizationId: "org-1", ownerId: "other-user" },
      ],
    });

    const access = await resolveWorkspaceAccess(
      db,
      { id: "u1", role: "user" },
      { role: "member" } as never,
      "org-1",
      "ws-1",
    );

    expect(access).toEqual({ allowed: false, reason: "no-access" });
  });

  it("grants the workspace owner, marking them as owner", async () => {
    const db = fakeDb({
      organizationMember: [],
      workspace: [{ id: "ws-1", organizationId: "org-1", ownerId: "u1" }],
    });

    const access = await resolveWorkspaceAccess(
      db,
      { id: "u1", role: "user" },
      { role: "member" } as never,
      "org-1",
      "ws-1",
    );

    expect(access).toEqual({ allowed: true, isWorkspaceOwner: true });
  });

  it("grants an org admin access to another member's workspace, marking them non-owner", async () => {
    const db = fakeDb({
      organizationMember: [],
      workspace: [
        { id: "ws-1", organizationId: "org-1", ownerId: "other-user" },
      ],
    });

    const access = await resolveWorkspaceAccess(
      db,
      { id: "u1", role: "user" },
      { role: "admin" } as never,
      "org-1",
      "ws-1",
    );

    expect(access).toEqual({ allowed: true, isWorkspaceOwner: false });
  });

  it("grants a super admin access to any workspace in the org", async () => {
    const db = fakeDb({
      organizationMember: [],
      workspace: [
        { id: "ws-1", organizationId: "org-1", ownerId: "other-user" },
      ],
    });

    const access = await resolveWorkspaceAccess(
      db,
      { id: "admin-1", role: "admin" },
      { role: "admin", isSuperAdmin: true },
      "org-1",
      "ws-1",
    );

    expect(access).toEqual({ allowed: true, isWorkspaceOwner: false });
  });
});
