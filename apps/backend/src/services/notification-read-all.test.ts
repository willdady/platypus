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

/**
 * Marking every Notification read, against an in-process Postgres built from
 * the shipped migrations, so the one-read-per-user constraint is the real one.
 */
const { dispatchEvent } = vi.hoisted(() => ({ dispatchEvent: vi.fn() }));
vi.mock("./event-dispatch.ts", () => ({ dispatchEvent }));

const { markAllRead, markRead } = await import("./notification.ts");

let pg: PGlite;
let database: ReturnType<typeof drizzle>;
beforeAll(async () => {
  pg = await migratedPglite();
  database = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

const ctx = { orgId: "org-1", workspaceId: "ws-1" };

/** Three Notifications in ws-1 and one in ws-2, none read. */
beforeEach(async () => {
  dispatchEvent.mockClear();
  await pg.exec(`
    DELETE FROM "organization";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at") VALUES
      ('u1', 'Jane', 'jane@example.com', true, now(), now()),
      ('u2', 'Joe', 'joe@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name") VALUES
      ('ws-1', 'org-1', 'u1', 'Support'),
      ('ws-2', 'org-1', 'u1', 'Sales');
    INSERT INTO "notification" ("id", "workspace_id", "body") VALUES
      ('n1', 'ws-1', 'One'),
      ('n2', 'ws-1', 'Two'),
      ('n3', 'ws-1', 'Three'),
      ('n-other', 'ws-2', 'Elsewhere');
  `);
});

const readRows = async () =>
  (
    await pg.query<{ notification_id: string; user_id: string }>(
      `SELECT "notification_id", "user_id" FROM "notification_read"
         ORDER BY "notification_id", "user_id"`,
    )
  ).rows;

describe("markAllRead", () => {
  it("reads every unread Notification in the Workspace, and only there", async () => {
    await markAllRead(database as never, ctx, "u1");

    expect(await readRows()).toEqual([
      { notification_id: "n1", user_id: "u1" },
      { notification_id: "n2", user_id: "u1" },
      { notification_id: "n3", user_id: "u1" },
    ]);
  });

  it("lets two concurrent calls both succeed, one read row each", async () => {
    await Promise.all([
      markAllRead(database as never, ctx, "u1"),
      markAllRead(database as never, ctx, "u1"),
    ]);

    expect(await readRows()).toEqual([
      { notification_id: "n1", user_id: "u1" },
      { notification_id: "n2", user_id: "u1" },
      { notification_id: "n3", user_id: "u1" },
    ]);
  });

  it("names only the newly read Notifications in its event", async () => {
    await markRead(database as never, ctx, "n2", "u1");
    dispatchEvent.mockClear();

    await markAllRead(database as never, ctx, "u1");

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const [, , event] = dispatchEvent.mock.calls[0] as [
      string,
      string,
      { event: string; data: { notificationIds: string[] } },
    ];
    expect(event.event).toBe("notification.read");
    expect([...event.data.notificationIds].sort()).toEqual(["n1", "n3"]);
    expect(event.data).toMatchObject({ userId: "u1", bulk: true });
  });

  it("dispatches nothing when everything is already read", async () => {
    await markAllRead(database as never, ctx, "u1");
    dispatchEvent.mockClear();

    await markAllRead(database as never, ctx, "u1");

    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("leaves another user's unread Notifications alone", async () => {
    await markAllRead(database as never, ctx, "u1");

    await markAllRead(database as never, ctx, "u2");

    expect((await readRows()).filter((r) => r.user_id === "u2")).toHaveLength(
      3,
    );
  });
});
