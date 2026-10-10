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
import { ValidationError } from "../errors.ts";

/**
 * A Workspace transfer (ADR-0035) run for real against an in-process Postgres
 * built from the shipped migrations: what it clears, what it keeps, and that
 * a refused one changes nothing.
 */
const { holder, cancelRun, stopRevokedA2aWork, deleteStoredPrefix } =
  vi.hoisted(() => ({
    holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
    cancelRun: vi.fn(async (_runId: string) => {}),
    stopRevokedA2aWork: vi.fn(async (_endpointIds: string[]) => {}),
    deleteStoredPrefix: vi.fn(async (_prefix: string) => {}),
  }));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));
vi.mock("../runs/run-cancel.ts", () => ({ cancelRun }));
vi.mock("./a2a-cancel.ts", () => ({ stopRevokedA2aWork }));
vi.mock("../storage/utils.ts", () => ({ deleteStoredPrefix }));

const { transferWorkspace } = await import("./workspace-transfer.ts");

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

/**
 * Org 1 has an admin (Ada), the Owner (Olive), a recipient (Nina) and a banned
 * member (Bea); Otto is a member of Org 2 only. Olive owns `ws-1`, which holds
 * one of everything a transfer touches, and `ws-2`, which a transfer of `ws-1`
 * must leave alone.
 */
beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec(`
    DELETE FROM "organization";
    DELETE FROM "provider";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "banned", "created_at", "updated_at") VALUES
      ('admin', 'Ada', 'ada@example.com', true, false, now(), now()),
      ('u-old', 'Olive', 'olive@example.com', true, false, now(), now()),
      ('u-new', 'Nina', 'nina@example.com', true, false, now(), now()),
      ('u-banned', 'Bea', 'bea@example.com', true, true, now(), now()),
      ('u-out', 'Otto', 'otto@example.com', true, false, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme'), ('org-2', 'Other');
    INSERT INTO "organization_member" ("id", "organization_id", "user_id", "role") VALUES
      ('m-admin', 'org-1', 'admin', 'admin'),
      ('m-old', 'org-1', 'u-old', 'member'),
      ('m-new', 'org-1', 'u-new', 'member'),
      ('m-banned', 'org-1', 'u-banned', 'member'),
      ('m-out', 'org-2', 'u-out', 'member');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name", "provider_self_management", "mcp_self_management") VALUES
      ('ws-1', 'org-1', 'u-old', 'Support', true, true),
      ('ws-2', 'org-1', 'u-old', 'Other', true, true);
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds") VALUES
      ('p-1', 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]'),
      ('p-2', 'ws-2', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id") VALUES
      ('agent-1', 'ws-1', 'p-1', 'Helper', 'Helps', 'm'),
      ('agent-2', 'ws-2', 'p-2', 'Helper', 'Helps', 'm');
    INSERT INTO "chat" ("id", "workspace_id", "title", "status") VALUES
      ('chat-run', 'ws-1', 'Running', 'running'),
      ('chat-done', 'ws-1', 'Done', 'succeeded'),
      ('chat-2', 'ws-2', 'Elsewhere', 'running');
    INSERT INTO "memory_daily_summary" ("id", "user_id", "workspace_id", "summary_date", "summary") VALUES
      ('mem-1', 'u-old', 'ws-1', '2026-10-01', 'Talked about invoices'),
      ('mem-2', 'u-old', 'ws-2', '2026-10-01', 'Elsewhere');
    INSERT INTO "notification" ("id", "workspace_id", "agent_id", "body") VALUES
      ('n-1', 'ws-1', 'agent-1', 'Done'),
      ('n-2', 'ws-2', 'agent-2', 'Done');
    INSERT INTO "trigger" ("id", "workspace_id", "agent_id", "type", "name", "instruction", "config", "enabled", "token_hash", "token_created_at", "token_expires_at") VALUES
      ('t-1', 'ws-1', 'agent-1', 'inbound', 'Inbound', 'Go', '{}', true, 'hash', now(), now() + interval '30 days'),
      ('t-cron', 'ws-1', 'agent-1', 'cron', 'Cron', 'Go', '{}', true, null, null, null),
      ('t-2', 'ws-2', 'agent-2', 'inbound', 'Inbound', 'Go', '{}', true, 'hash-2', now(), now() + interval '30 days');
    INSERT INTO "trigger_run" ("id", "trigger_id", "status") VALUES
      ('run-pending', 't-1', 'pending'),
      ('run-running', 't-cron', 'running'),
      ('run-done', 't-cron', 'success'),
      ('run-2', 't-2', 'running');
    INSERT INTO "a2a_endpoint" ("id", "workspace_id", "agent_id", "name", "description") VALUES
      ('ep-1', 'ws-1', 'agent-1', 'Helper', 'Helps'),
      ('ep-2', 'ws-2', 'agent-2', 'Helper', 'Helps');
    INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_created_at", "token_expires_at") VALUES
      ('tok-1', 'ep-1', 'Client', 'h1', now(), now() + interval '30 days'),
      ('tok-2', 'ep-2', 'Client', 'h2', now(), now() + interval '30 days');
    INSERT INTO "mcp" ("id", "workspace_id", "name", "slug", "auth_type", "bearer_token", "oauth_access_token", "oauth_refresh_token", "oauth_token_expires_at", "oauth_scope", "oauth_client_id") VALUES
      ('mcp-1', 'ws-1', 'Bearer', 'bearer', 'bearer', 'secret', null, null, null, null, null),
      ('mcp-oauth', 'ws-1', 'OAuth', 'oauth', 'oauth', null, 'access', 'refresh', now(), 'read', 'client'),
      ('mcp-2', 'ws-2', 'Bearer', 'bearer', 'bearer', 'secret-2', null, null, null, null, null);
    INSERT INTO "mcp_oauth_state" ("id", "mcp_id", "code_verifier", "redirect_uri", "expires_at") VALUES
      ('state-1', 'mcp-oauth', 'v', 'https://example.com/cb', now() + interval '10 minutes');
    INSERT INTO "sandbox" ("id", "workspace_id", "name", "backend", "admin_env", "user_env") VALUES
      ('sb-1', 'ws-1', 'Box', 'docker', '{"ADMIN":"1"}', '{"MINE":"1"}'),
      ('sb-2', 'ws-2', 'Box', 'docker', '{}', '{"MINE":"2"}');
    INSERT INTO "context" ("id", "user_id", "workspace_id", "content") VALUES
      ('ctx-1', 'u-old', 'ws-1', 'I am Olive');
    INSERT INTO "kanban_board" ("id", "workspace_id", "name") VALUES ('board-1', 'ws-1', 'Work');
    INSERT INTO "dashboard" ("id", "workspace_id", "name") VALUES ('dash-1', 'ws-1', 'Stats');
  `);
});

const rows = async (sql: string) => (await pg.query(sql)).rows;
const ids = async (table: string, where = "true") =>
  (await rows(`SELECT "id" FROM "${table}" WHERE ${where} ORDER BY "id"`)).map(
    (r) => (r as { id: string }).id,
  );

const transfer = (
  newOwnerId: string,
  keepHistory = true,
  workspaceId = "ws-1",
) =>
  transferWorkspace({
    orgId: "org-1",
    workspaceId,
    newOwnerId,
    keepHistory,
    transferredBy: "Ada",
  });

describe("transferWorkspace", () => {
  it("makes the recipient the Owner", async () => {
    await transfer("u-new");

    expect(
      await rows(`SELECT "id", "owner_id" FROM "workspace" ORDER BY "id"`),
    ).toEqual([
      { id: "ws-1", owner_id: "u-new" },
      { id: "ws-2", owner_id: "u-old" },
    ]);
  });

  it.each([
    ["a member of another Organization", "u-out"],
    ["a User who does not exist", "nobody"],
    ["a banned member", "u-banned"],
    ["the current Owner", "u-old"],
  ])("refuses %s and changes nothing", async (_, newOwnerId) => {
    const before = await rows(`SELECT * FROM "workspace" ORDER BY "id"`);

    await expect(transfer(newOwnerId)).rejects.toThrow(ValidationError);

    expect(await rows(`SELECT * FROM "workspace" ORDER BY "id"`)).toEqual(
      before,
    );
    expect(await ids("trigger", `"enabled"`)).toEqual(["t-1", "t-2", "t-cron"]);
  });

  it("accepts a member whose ban has expired", async () => {
    await pg.exec(
      `UPDATE "user" SET "ban_expires" = now() - interval '1 day' WHERE "id" = 'u-banned'`,
    );

    await transfer("u-banned");

    expect(
      await rows(`SELECT "owner_id" FROM "workspace" WHERE "id" = 'ws-1'`),
    ).toEqual([{ owner_id: "u-banned" }]);
  });
});

describe("transferWorkspace, whatever the history choice", () => {
  it.each([true, false])(
    "with keepHistory %s, cuts off everything that acts as the Owner",
    async (keepHistory) => {
      await transfer("u-new", keepHistory);

      expect(
        await rows(
          `SELECT "id", "enabled", "token_hash", "token_expires_at" IS NULL AS "no_expiry" FROM "trigger" ORDER BY "id"`,
        ),
      ).toEqual([
        { id: "t-1", enabled: false, token_hash: null, no_expiry: true },
        {
          id: "t-2",
          enabled: true,
          token_hash: "hash-2",
          no_expiry: false,
        },
        {
          id: "t-cron",
          enabled: false,
          token_hash: null,
          no_expiry: true,
        },
      ]);
      expect(await ids("a2a_token")).toEqual(["tok-2"]);
      expect(
        await rows(
          `SELECT "id", "bearer_token", "oauth_access_token", "oauth_refresh_token", "oauth_client_id" FROM "mcp" ORDER BY "id"`,
        ),
      ).toEqual([
        {
          id: "mcp-1",
          bearer_token: null,
          oauth_access_token: null,
          oauth_refresh_token: null,
          oauth_client_id: null,
        },
        {
          id: "mcp-2",
          bearer_token: "secret-2",
          oauth_access_token: null,
          oauth_refresh_token: null,
          oauth_client_id: null,
        },
        {
          id: "mcp-oauth",
          bearer_token: null,
          oauth_access_token: null,
          oauth_refresh_token: null,
          oauth_client_id: "client",
        },
      ]);
      expect(await ids("mcp_oauth_state")).toEqual([]);
      expect(
        await rows(
          `SELECT "id", "admin_env", "user_env" FROM "sandbox" ORDER BY "id"`,
        ),
      ).toEqual([
        { id: "sb-1", admin_env: { ADMIN: "1" }, user_env: {} },
        { id: "sb-2", admin_env: {}, user_env: { MINE: "2" } },
      ]);
      expect(
        await rows(
          `SELECT "id", "provider_self_management", "mcp_self_management" FROM "workspace" ORDER BY "id"`,
        ),
      ).toEqual([
        {
          id: "ws-1",
          provider_self_management: false,
          mcp_self_management: false,
        },
        {
          id: "ws-2",
          provider_self_management: true,
          mcp_self_management: true,
        },
      ]);
    },
  );

  it.each([true, false])(
    "with keepHistory %s, keeps the work products, the Providers and the old Owner's Context",
    async (keepHistory) => {
      await transfer("u-new", keepHistory);

      expect(await ids("kanban_board")).toEqual(["board-1"]);
      expect(await ids("dashboard")).toEqual(["dash-1"]);
      expect(await ids("sandbox")).toEqual(["sb-1", "sb-2"]);
      expect(await ids("provider")).toEqual(["p-1", "p-2"]);
      expect(
        await rows(`SELECT "id", "user_id", "workspace_id" FROM "context"`),
      ).toEqual([{ id: "ctx-1", user_id: "u-old", workspace_id: "ws-1" }]);
    },
  );

  it("cancels the running Chat turns, Trigger runs and A2A Tasks after commit", async () => {
    await transfer("u-new");

    expect(cancelRun.mock.calls.map(([id]) => id).sort()).toEqual([
      "chat-run",
      "run-running",
    ]);
    expect(stopRevokedA2aWork).toHaveBeenCalledWith(["ep-1"]);
    expect(
      await rows(
        `SELECT "id", "status" FROM "trigger_run" WHERE "id" = 'run-pending'`,
      ),
    ).toEqual([{ id: "run-pending", status: "cancelled" }]);
  });

  it("cancels nothing when the transfer is refused", async () => {
    await expect(transfer("u-out")).rejects.toThrow(ValidationError);

    expect(cancelRun).not.toHaveBeenCalled();
    expect(stopRevokedA2aWork).not.toHaveBeenCalled();
  });

  it("tells the new Owner, in the Workspace, without an Agent", async () => {
    await transfer("u-new");

    const [notice] = (await rows(
      `SELECT "agent_id", "body" FROM "notification" WHERE "workspace_id" = 'ws-1' AND "agent_id" IS NULL`,
    )) as { agent_id: null; body: string }[];
    expect(notice.body).toContain("Ada transferred this Workspace to you");
    expect(notice.body).toContain("Chats and Memories came with it");
    expect(notice.body).toContain("Trigger is switched off");
    expect(notice.body).toContain("token was revoked");
    expect(notice.body).toContain("authorizing again");
  });
});

describe("transferWorkspace, keeping history", () => {
  it("keeps the Chats and Notifications, and moves the old Owner's Memories to the new Owner", async () => {
    await transfer("u-new", true);

    expect(await ids("chat")).toEqual(["chat-2", "chat-done", "chat-run"]);
    expect(await ids("trigger_run")).toEqual([
      "run-2",
      "run-done",
      "run-pending",
      "run-running",
    ]);
    expect(
      await rows(
        `SELECT "id", "user_id" FROM "memory_daily_summary" ORDER BY "id"`,
      ),
    ).toEqual([
      { id: "mem-1", user_id: "u-new" },
      { id: "mem-2", user_id: "u-old" },
    ]);
    expect(await ids("notification", `"agent_id" IS NOT NULL`)).toEqual([
      "n-1",
      "n-2",
    ]);
  });
});

describe("transferWorkspace, clearing history", () => {
  it("deletes the Chats, Trigger-run transcripts, Memories and Notifications", async () => {
    await transfer("u-new", false);

    expect(await ids("chat")).toEqual(["chat-2"]);
    expect(await ids("trigger_run")).toEqual(["run-2"]);
    expect(await ids("memory_daily_summary")).toEqual(["mem-2"]);
    expect(await ids("notification", `"agent_id" IS NOT NULL`)).toEqual([
      "n-2",
    ]);
    const [notice] = (await rows(
      `SELECT "body" FROM "notification" WHERE "workspace_id" = 'ws-1'`,
    )) as { body: string }[];
    expect(notice.body).toContain(
      "Chats, Memories and Notifications were cleared",
    );
    expect(deleteStoredPrefix.mock.calls.map(([p]) => p).sort()).toEqual([
      "org-1/ws-1/chat-done/",
      "org-1/ws-1/chat-run/",
    ]);
  });
});
