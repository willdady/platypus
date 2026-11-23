import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";

const { holder } = vi.hoisted(() => {
  const holder: { db?: ReturnType<typeof drizzle> } = {};
  return { holder };
});
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db;
  },
}));

const { acceptInvitationForUser } = await import("./invitation-accept.ts");

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  holder.db = drizzle(pg);

  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now()),
             ('admin', 'Admin', 'admin@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
  `);
}, 60_000);
afterAll(() => pg.close());

const invite = (id: string, email: string) =>
  pg.query(
    `INSERT INTO "invitation" ("id", "email", "organization_id", "invited_by", "token", "expires_at")
       VALUES ($1, $2, 'org-1', 'admin', $3, now() + interval '7 days')`,
    [id, email, id],
  );

describe("acceptInvitationForUser", () => {
  it("leaves one membership when two invitations to the same Organization are accepted", async () => {
    await invite("inv-a", "jane@example.com");
    await invite("inv-b", "jane@work.example.com");

    const results = await Promise.all([
      acceptInvitationForUser("inv-a", {
        id: "u1",
        name: "Jane",
        email: "jane@example.com",
      }),
      acceptInvitationForUser("inv-b", {
        id: "u1",
        name: "Jane",
        email: "jane@work.example.com",
      }),
    ]);

    expect(results.map((r) => r.outcome)).toEqual(["accepted", "accepted"]);
    const { rows } = await pg.query(
      `SELECT 1 FROM "organization_member" WHERE "organization_id" = 'org-1' AND "user_id" = 'u1'`,
    );
    expect(rows).toHaveLength(1);
  });
});
