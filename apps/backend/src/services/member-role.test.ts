import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";

/**
 * Role changes against an in-process Postgres built from the shipped
 * migrations, so the last-admin guard is checked against real transactions.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));

const { changeMemberRole } = await import("./member-role.ts");

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

/** Ada and Bea are the two admins of Org 1; Cal is a member. */
beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "organization";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at") VALUES
      ('u-a', 'Ada', 'ada@example.com', true, now(), now()),
      ('u-b', 'Bea', 'bea@example.com', true, now(), now()),
      ('u-c', 'Cal', 'cal@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme'), ('org-2', 'Other');
    INSERT INTO "organization_member" ("id", "organization_id", "user_id", "role") VALUES
      ('m-a', 'org-1', 'u-a', 'admin'),
      ('m-b', 'org-1', 'u-b', 'admin'),
      ('m-c', 'org-1', 'u-c', 'member'),
      ('m-c-2', 'org-2', 'u-c', 'admin');
  `);
});

const admins = async () =>
  (
    await pg.query<{ id: string }>(
      `SELECT "id" FROM "organization_member"
         WHERE "organization_id" = 'org-1' AND "role" = 'admin' ORDER BY "id"`,
    )
  ).rows.map((r) => r.id);

describe("changeMemberRole", () => {
  it("demotes an admin while another admin remains", async () => {
    const updated = await changeMemberRole({
      orgId: "org-1",
      memberId: "m-b",
      role: "member",
      actorUserId: "u-a",
    });

    expect(updated).toMatchObject({ id: "m-b", role: "member" });
    expect(await admins()).toEqual(["m-a"]);
  });

  it("promotes a member", async () => {
    await changeMemberRole({
      orgId: "org-1",
      memberId: "m-c",
      role: "admin",
      actorUserId: "u-a",
    });

    expect(await admins()).toEqual(["m-a", "m-b", "m-c"]);
  });

  it("refuses to demote yourself", async () => {
    await expect(
      changeMemberRole({
        orgId: "org-1",
        memberId: "m-a",
        role: "member",
        actorUserId: "u-a",
      }),
    ).rejects.toThrow(
      new ValidationError("You cannot demote yourself from admin"),
    );
    expect(await admins()).toEqual(["m-a", "m-b"]);
  });

  it.each(["member", "admin"] as const)(
    "answers not found to a member of another Organization (%s)",
    async (role) => {
      await expect(
        changeMemberRole({
          orgId: "org-1",
          memberId: "m-c-2",
          role,
          actorUserId: "u-a",
        }),
      ).rejects.toThrow(NotFoundError);
    },
  );

  it("refuses to demote the last admin", async () => {
    await pg.exec(
      `UPDATE "organization_member" SET "role" = 'member' WHERE "id" = 'm-a'`,
    );

    await expect(
      changeMemberRole({
        orgId: "org-1",
        memberId: "m-b",
        role: "member",
        actorUserId: "super",
      }),
    ).rejects.toThrow(
      new ConflictError("Cannot demote the last organization admin"),
    );
    expect(await admins()).toEqual(["m-b"]);
  });

  // PGlite runs the two transactions one after the other, so this pins that
  // the guard and the write share a transaction (separate statements
  // interleave and both demotions pass); it cannot prove the `organization`
  // row lock that serialises them in Postgres.
  it("leaves one admin when two admins demote each other at once", async () => {
    const results = await Promise.allSettled([
      changeMemberRole({
        orgId: "org-1",
        memberId: "m-b",
        role: "member",
        actorUserId: "u-a",
      }),
      changeMemberRole({
        orgId: "org-1",
        memberId: "m-a",
        role: "member",
        actorUserId: "u-b",
      }),
    ]);

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);
    expect(await admins()).toHaveLength(1);
  });
});
