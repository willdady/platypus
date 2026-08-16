import { describe, it, expect, vi } from "vitest";

/**
 * `eq`/`and` are replaced with introspectable markers so the in-memory fake
 * database below can interpret a real Drizzle `where` condition without
 * parsing SQL — the same technique `db/seed.test.ts` uses. This is what makes
 * these tests different from the rest of the suite, which stubs `eq`/`and` as
 * no-ops via `test-utils.ts`: here, a query that dropped a column from its
 * `and(...)` (e.g. matching on `userId` alone) filters the fixture rows
 * incorrectly and the test fails, instead of the condition being invisible.
 */
vi.mock("drizzle-orm", async () => {
  const actual =
    await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (column: { name: string }, value: unknown) => ({
      column: column.name,
      value,
    }),
    and: (...conditions: unknown[]) => ({
      and: conditions.filter(Boolean),
    }),
  };
});

import { organizationMember, workspace } from "../db/schema.ts";
import {
  resolveOrgMembership,
  resolveWorkspaceAccess,
  type Database,
} from "./authorization.ts";

type Row = Record<string, unknown>;
type EqCondition = { column: string; value: unknown };
type AndCondition = { and: Condition[] };
type Condition = EqCondition | AndCondition | undefined;

/** Snake-cased column names from `eq` map back onto camel-cased row keys. */
const toCamel = (name: string) =>
  name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const isAnd = (condition: Condition): condition is AndCondition =>
  condition != null && "and" in condition;

const matches = (row: Row, condition: Condition): boolean => {
  if (!condition) return true;
  if (isAnd(condition)) {
    return condition.and.every((c) => matches(row, c));
  }
  return (
    row[condition.column] === condition.value ||
    row[toCamel(condition.column)] === condition.value
  );
};

/**
 * A minimal in-memory stand-in for the Drizzle handle, covering only
 * `select().from(table).where(condition).limit(n)` — everything
 * {@link resolveOrgMembership} and {@link resolveWorkspaceAccess} issue.
 */
const fakeDb = (tables: { organizationMember: Row[]; workspace: Row[] }) => {
  const rowsFor = (table: unknown): Row[] => {
    if (table === organizationMember) return tables.organizationMember;
    if (table === workspace) return tables.workspace;
    throw new Error("Fake db has no such table");
  };

  return {
    select() {
      let table: unknown;
      let condition: Condition;
      let take = Infinity;
      const builder = {
        from(t: unknown) {
          table = t;
          return builder;
        },
        where(c: Condition) {
          condition = c;
          return builder;
        },
        limit(n: number) {
          take = n;
          return builder;
        },
        then(
          onFulfilled: (rows: Row[]) => unknown,
          onRejected?: () => unknown,
        ) {
          const rows = rowsFor(table)
            .filter((row) => matches(row, condition))
            .slice(0, take);
          return Promise.resolve(rows).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  } as unknown as Database;
};

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
