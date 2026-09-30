import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { mockNanoid } from "../test-setup.ts";

/**
 * Re-inviting an address (#1131), run against an in-process Postgres built
 * from the shipped migrations: only a *pending* invitation may block a new
 * one, and that rests on the unique index production actually has.
 */
const { holder, getSession } = vi.hoisted(() => {
  const holder: { db?: ReturnType<typeof drizzle> } = {};
  return { holder, getSession: vi.fn() };
});
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("../auth.ts", () => ({ auth: { api: { getSession } } }));

process.env.ALLOWED_ORIGINS = "http://localhost:3000";
process.env.STORAGE_BACKEND = "disk";
const { default: app } = await import("../server.ts");

const orgId = "org-1";
const baseUrl = `/organizations/${orgId}/invitations`;

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  holder.db = drizzle(pg);

  let n = 0;
  mockNanoid.mockImplementation(() => `id-${++n}`.padEnd(21, "x"));

  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('admin', 'Admin', 'admin@example.com', true, now(), now()),
             ('jane', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "organization_member" ("id", "organization_id", "user_id", "role")
      VALUES ('m-admin', 'org-1', 'admin', 'admin');
  `);
}, 60_000);
afterAll(() => pg.close());

const signInAs = (id: string, email: string) =>
  getSession.mockResolvedValue({
    user: { id, email, role: "user" },
    session: { id: "session-1" },
  });

beforeEach(async () => {
  signInAs("admin", "admin@example.com");
  await pg.exec(`
    DELETE FROM "invitation";
    DELETE FROM "organization_member" WHERE "user_id" = 'jane';
  `);
});

const seedInvitation = (
  id: string,
  status: string,
  expiresIn: "7 days" | "-1 day" = "7 days",
) =>
  pg.query(
    `INSERT INTO "invitation" ("id", "email", "organization_id", "invited_by", "status", "token", "expires_at")
       VALUES ($1, 'jane@example.com', 'org-1', 'admin', $2, $1, now() + $3::interval)`,
    [id, status, expiresIn],
  );

const invite = () =>
  app.request(baseUrl, {
    method: "POST",
    body: JSON.stringify({ email: "jane@example.com" }),
    headers: { "Content-Type": "application/json" },
  });

/** Each invitation's status, keyed by id, as the admin's list reports it. */
const statuses = async () => {
  const res = await app.request(baseUrl);
  const { results } = (await res.json()) as {
    results: { id: string; status: string }[];
  };
  return Object.fromEntries(results.map((r) => [r.id, r.status]));
};

describe("POST /organizations/:orgId/invitations — re-inviting", () => {
  it.each(["declined", "expired", "accepted"])(
    "invites an address whose earlier invitation was %s",
    async (status) => {
      await seedInvitation("inv-old", status);

      const res = await invite();

      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({
        email: "jane@example.com",
        status: "pending",
      });
    },
  );

  it("invites an address whose pending invitation has lapsed, marking the lapsed one expired", async () => {
    await seedInvitation("inv-lapsed", "pending", "-1 day");

    const res = await invite();

    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await statuses()).toEqual({
      "inv-lapsed": "expired",
      [id]: "pending",
    });
  });

  it("409s while a live pending invitation exists", async () => {
    await seedInvitation("inv-live", "pending");

    const res = await invite();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "A pending invitation already exists for this user and organization",
    });
  });

  // Their accepted invitation no longer holds the slot, so membership itself
  // must refuse: accepting would otherwise provision a second Workspace.
  it("409s for an address that is already a member", async () => {
    await seedInvitation("inv-accepted", "accepted");
    await pg.exec(`
      INSERT INTO "organization_member" ("id", "organization_id", "user_id", "role")
        VALUES ('m-jane', 'org-1', 'jane', 'member');
    `);

    const res = await invite();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "This user is already a member of the organization",
    });
  });

  it("offers the invitee only the new invitation, not the history", async () => {
    await seedInvitation("inv-declined", "declined");
    const { id } = (await (await invite()).json()) as { id: string };

    signInAs("jane", "jane@example.com");
    const res = await app.request("/users/me/invitations");

    const { results } = (await res.json()) as { results: { id: string }[] };
    expect(results.map((r) => r.id)).toEqual([id]);
  });
});
