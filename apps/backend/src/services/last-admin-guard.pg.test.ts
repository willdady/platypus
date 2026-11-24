import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  createScratchPostgres,
  type ScratchPostgres,
} from "../db/postgres.test-fixtures.ts";

type Outcome = "blocked" | "ran" | "failed";
type MemberRoleService = typeof import("./member-role.ts");
type MemberRemovalService = typeof import("./member-removal.ts");
type BackendModule = typeof import("../index.ts");

let scratch: ScratchPostgres;
let pool: BackendModule["pool"];
let holder: pg.Client;
let watcher: pg.Client;
let changeMemberRole: MemberRoleService["changeMemberRole"];
let removeMember: MemberRemovalService["removeMember"];
let ready = false;

beforeAll(async () => {
  scratch = await createScratchPostgres("last_admin_guard");
  process.env.DATABASE_URL = scratch.url;
  ({ changeMemberRole } = await import("./member-role.ts"));
  ({ removeMember } = await import("./member-removal.ts"));
  ({ pool } = await import("../index.ts"));
  holder = new pg.Client({ connectionString: scratch.url });
  watcher = new pg.Client({ connectionString: scratch.url });
  await holder.connect();
  await watcher.connect();
  ready = true;
});

afterAll(async () => {
  // why: a beforeAll that failed leaves these unset, and its error is the one to report
  if (!ready) return;
  await pool.end();
  await holder.end();
  await watcher.end();
  await scratch.drop();
});

beforeEach(async () => {
  await holder.query(`
    DELETE FROM "organization";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at") VALUES
      ('u-a', 'Ada', 'ada@example.com', true, now(), now()),
      ('u-b', 'Bea', 'bea@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "organization_member" ("id", "organization_id", "user_id", "role") VALUES
      ('m-a', 'org-1', 'u-a', 'admin'),
      ('m-b', 'org-1', 'u-b', 'admin');
  `);
});

const idsWhereRole = async (role: string) =>
  (
    await watcher.query<{ id: string }>(
      `SELECT "id" FROM "organization_member"
         WHERE "organization_id" = 'org-1' AND "role" = $1 ORDER BY "id"`,
      [role],
    )
  ).rows.map((row) => row.id);

// why: pg_blocking_pids names the connections waiting behind the lock, so the race settles either way
const waitForBlockedBy = async (call: Promise<unknown>): Promise<Outcome> => {
  const { rows } = await holder.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = rows[0].pid;
  let watching = true;
  const waitForWaiter = async (): Promise<Outcome> => {
    while (watching) {
      const { rows: waiting } = await watcher.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [pid],
      );
      if (waiting[0].count > 0) return "blocked";
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return "ran";
  };
  try {
    return await Promise.race([
      call.then(
        () => "ran" as const,
        () => "failed" as const,
      ),
      waitForWaiter(),
    ]);
  } finally {
    watching = false;
  }
};

const whileOrganizationLocked = async <T>(
  act: () => Promise<T>,
): Promise<T> => {
  await holder.query("BEGIN");
  await holder.query(
    `SELECT "id" FROM "organization" WHERE "id" = 'org-1' FOR UPDATE`,
  );
  const call = act();
  call.catch(() => {});
  try {
    expect(await waitForBlockedBy(call)).toBe("blocked");
    await holder.query("COMMIT");
    return await call;
  } finally {
    await holder.query("ROLLBACK");
  }
};

describe("the last-admin guard's Organization row lock", () => {
  it("makes a demotion wait for the lock", async () => {
    const demoted = await whileOrganizationLocked(() =>
      changeMemberRole({
        orgId: "org-1",
        memberId: "m-b",
        role: "member",
        actorUserId: "u-a",
      }),
    );

    expect(demoted).toMatchObject({ id: "m-b", role: "member" });
    expect(await idsWhereRole("admin")).toEqual(["m-a"]);
  });

  it("makes a removal wait for the lock", async () => {
    await whileOrganizationLocked(() =>
      removeMember({
        orgId: "org-1",
        memberId: "m-b",
        actorUserId: "u-a",
        workspaces: [],
        transferredBy: "Ada",
      }),
    );

    expect(await idsWhereRole("admin")).toEqual(["m-a"]);
    expect(await idsWhereRole("member")).toEqual([]);
  });
});
