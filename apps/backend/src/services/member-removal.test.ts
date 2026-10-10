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
import type { MemberWorkspaceDecision } from "@platypus/schemas";
import { migratedPglite } from "../db/migrated-pglite.test-fixtures.ts";
import { ValidationError } from "../errors.ts";

/**
 * Remove from Org (ADR-0035) against an in-process Postgres built from the
 * shipped migrations: every Workspace the member owns is transferred or
 * deleted with the removal, all of it or none of it.
 */
const { holder, cancelRun, deleteStoredPrefix } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
  cancelRun: vi.fn(async (_runId: string) => {}),
  deleteStoredPrefix: vi.fn(async (_prefix: string) => {}),
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));
vi.mock("../runs/run-cancel.ts", () => ({ cancelRun }));
vi.mock("./a2a-cancel.ts", () => ({ stopRevokedA2aWork: async () => {} }));
vi.mock("../storage/utils.ts", () => ({ deleteStoredPrefix }));

const { removeMember } = await import("./member-removal.ts");

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

/**
 * Olive, a member of Org 1, owns `ws-a` and `ws-b` there and `ws-x` in Org 2;
 * Nina is another member of Org 1, Otto a member of Org 2 only.
 */
beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec(`
    DELETE FROM "organization";
    DELETE FROM "user";
    DELETE FROM "sandbox_teardown_failure";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at") VALUES
      ('admin', 'Ada', 'ada@example.com', true, now(), now()),
      ('u-old', 'Olive', 'olive@example.com', true, now(), now()),
      ('u-new', 'Nina', 'nina@example.com', true, now(), now()),
      ('u-out', 'Otto', 'otto@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme'), ('org-2', 'Other');
    INSERT INTO "organization_member" ("id", "organization_id", "user_id", "role") VALUES
      ('m-admin', 'org-1', 'admin', 'admin'),
      ('m-old', 'org-1', 'u-old', 'member'),
      ('m-new', 'org-1', 'u-new', 'member'),
      ('m-old-2', 'org-2', 'u-old', 'member'),
      ('m-out', 'org-2', 'u-out', 'member');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name") VALUES
      ('ws-a', 'org-1', 'u-old', 'A'),
      ('ws-b', 'org-1', 'u-old', 'B'),
      ('ws-x', 'org-2', 'u-old', 'X');
    INSERT INTO "sandbox" ("id", "workspace_id", "name", "backend") VALUES
      ('sb-b', 'ws-b', 'Box', 'unregistered');
  `);
});

const rows = async (sql: string) => (await pg.query(sql)).rows;
const workspaces = () =>
  rows(`SELECT "id", "owner_id" FROM "workspace" ORDER BY "id"`);
const members = async () =>
  (await rows(`SELECT "id" FROM "organization_member" ORDER BY "id"`)).map(
    (r) => (r as { id: string }).id,
  );

const remove = (workspaces: MemberWorkspaceDecision[]) =>
  removeMember({
    orgId: "org-1",
    member: { id: "m-old", userId: "u-old" },
    workspaces,
    transferredBy: "Ada",
  });

const before = [
  { id: "ws-a", owner_id: "u-old" },
  { id: "ws-b", owner_id: "u-old" },
  { id: "ws-x", owner_id: "u-old" },
];
const allMembers = ["m-admin", "m-new", "m-old", "m-old-2", "m-out"];

describe("removeMember", () => {
  it("transfers and deletes each owned Workspace, then removes the member", async () => {
    await remove([
      {
        workspaceId: "ws-a",
        action: "transfer",
        newOwnerId: "u-new",
        keepHistory: true,
      },
      { workspaceId: "ws-b", action: "delete" },
    ]);

    expect(await workspaces()).toEqual([
      { id: "ws-a", owner_id: "u-new" },
      { id: "ws-x", owner_id: "u-old" },
    ]);
    expect(await members()).toEqual(["m-admin", "m-new", "m-old-2", "m-out"]);
  });

  it("tears down a deleted Workspace's Sandbox and files after commit", async () => {
    await remove([
      {
        workspaceId: "ws-a",
        action: "transfer",
        newOwnerId: "u-new",
        keepHistory: true,
      },
      { workspaceId: "ws-b", action: "delete" },
    ]);

    // The backend is not registered, so its teardown fails into the ledger.
    expect(
      await rows(`SELECT "workspace_id" FROM "sandbox_teardown_failure"`),
    ).toEqual([{ workspace_id: "ws-b" }]);
    expect(deleteStoredPrefix).toHaveBeenCalledWith("org-1/ws-b/");
  });

  it("removes a member who owns no Workspaces with no decisions", async () => {
    await pg.exec(`DELETE FROM "workspace" WHERE "organization_id" = 'org-1'`);

    await remove([]);

    expect(await members()).not.toContain("m-old");
  });

  it.each<[string, MemberWorkspaceDecision[]]>([
    ["a decision is missing", [{ workspaceId: "ws-a", action: "delete" }]],
    [
      "a decision names a Workspace the member does not own here",
      [
        { workspaceId: "ws-a", action: "delete" },
        { workspaceId: "ws-b", action: "delete" },
        { workspaceId: "ws-x", action: "delete" },
      ],
    ],
    [
      "a Workspace is decided twice",
      [
        { workspaceId: "ws-a", action: "delete" },
        { workspaceId: "ws-a", action: "delete" },
      ],
    ],
    [
      "one transfer is invalid",
      [
        { workspaceId: "ws-a", action: "delete" },
        {
          workspaceId: "ws-b",
          action: "transfer",
          newOwnerId: "u-out",
          keepHistory: true,
        },
      ],
    ],
    [
      "a transfer names the member being removed",
      [
        { workspaceId: "ws-a", action: "delete" },
        {
          workspaceId: "ws-b",
          action: "transfer",
          newOwnerId: "u-old",
          keepHistory: true,
        },
      ],
    ],
  ])("changes nothing when %s", async (_, decisions) => {
    await expect(remove(decisions)).rejects.toThrow(ValidationError);

    expect(await workspaces()).toEqual(before);
    expect(await members()).toEqual(allMembers);
    expect(
      await rows(`SELECT "workspace_id" FROM "sandbox_teardown_failure"`),
    ).toEqual([]);
    expect(deleteStoredPrefix).not.toHaveBeenCalled();
  });

  it("changes nothing when a Workspace is created for the member mid-removal", async () => {
    // Lands after the decisions were checked, before the removal commits.
    const transaction = holder.db!.transaction.bind(holder.db);
    vi.spyOn(holder.db!, "transaction").mockImplementationOnce(
      async (...args) => {
        await pg.exec(`INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
          VALUES ('ws-late', 'org-1', 'u-old', 'Late')`);
        return transaction(...args);
      },
    );

    await expect(
      remove([
        { workspaceId: "ws-a", action: "delete" },
        { workspaceId: "ws-b", action: "delete" },
      ]),
    ).rejects.toThrow(ValidationError);

    expect(await members()).toEqual(allMembers);
    expect(deleteStoredPrefix).not.toHaveBeenCalled();
  });
});
