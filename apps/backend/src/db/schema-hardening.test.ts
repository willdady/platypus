import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

/**
 * The schema hardening (#1770), run for real against an in-process Postgres
 * built from the shipped migrations: the pre-hardening rows are seeded, the
 * migration backfills them, and the constraints it adds are then exercised.
 */
const TAG = "0100_same_kitty_pryde";

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite(TAG);
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "banned")
      VALUES ('u1', 'Jane', 'jane@example.com', NULL);
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name", "max_daily_summaries")
      VALUES ('ws-1', 'org-1', 'u1', 'Support', NULL);
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('p1', 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id", "tool_set_ids", "skill_ids", "sub_agent_ids")
      VALUES ('agent-1', 'ws-1', 'p1', 'Helper', 'Helps', 'm', NULL, NULL, NULL);
    INSERT INTO "chat" ("id", "workspace_id", "title", "tags", "run_heartbeat_at", "last_turn_at")
      VALUES ('chat-1', 'ws-1', 'Legacy', NULL, NULL, '2026-01-01 00:00:00'),
             ('chat-2', 'ws-1', 'Never run', NULL, NULL, NULL);
    INSERT INTO "invitation" ("id", "email", "organization_id", "token", "status", "expires_at")
      VALUES ('inv-1', 'old@example.com', 'org-1', NULL, 'accepted', '2025-01-01 00:00:00');
    INSERT INTO "trigger" ("id", "workspace_id", "agent_id", "type", "name", "instruction", "config")
      VALUES ('trig-cron', 'ws-1', 'agent-1', 'cron', 'Nightly', 'Do it',
              '{"cronExpression":"0 0 * * *"}'::jsonb),
             ('trig-inbound', 'ws-1', 'agent-1', 'inbound', 'Hook', 'Do it', '{}'::jsonb),
             ('trig-event', 'ws-1', 'agent-1', 'event', 'On card', 'Do it',
              '{"events":["card.created"]}'::jsonb);
    INSERT INTO "trigger_run" ("id", "trigger_id", "status", "event_type")
      VALUES ('run-1', 'trig-event', 'success', 'card.created');
    INSERT INTO "trigger_run_event" ("id", "run_id", "seq", "type", "status", "started_at")
      VALUES ('evt-1', 'run-1', 1, 'text', 'completed', 0);
  `);
  await applyMigration(pg, TAG);
}, 120_000);
afterAll(() => pg.close());

const rows = async <T>(sql: string) => (await pg.query<T>(sql)).rows;

describe("the 0100 backfill", () => {
  it("gives an Agent's id arrays an empty array", async () => {
    expect(
      await rows(
        `SELECT "tool_set_ids", "skill_ids", "sub_agent_ids" FROM "agent" WHERE "id" = 'agent-1'`,
      ),
    ).toEqual([{ tool_set_ids: [], skill_ids: [], sub_agent_ids: [] }]);
  });

  it("gives Chat tags an empty array", async () => {
    expect(await rows(`SELECT "tags" FROM "chat" ORDER BY "id"`)).toEqual([
      { tags: [] },
      { tags: [] },
    ]);
  });

  it("seeds a heartbeat from the turn, then the row's own update time", async () => {
    expect(
      await rows(`
        SELECT "id", "run_heartbeat_at" IS NOT NULL AS "stamped"
        FROM "chat" ORDER BY "id"
      `),
    ).toEqual([
      { id: "chat-1", stamped: true },
      { id: "chat-2", stamped: true },
    ]);
    expect(
      await rows(`
        SELECT "run_heartbeat_at" = "last_turn_at" AS "from_turn"
        FROM "chat" WHERE "id" = 'chat-1'
      `),
    ).toEqual([{ from_turn: true }]);
    expect(
      await rows(`
        SELECT "run_heartbeat_at" = "updated_at" AS "from_update"
        FROM "chat" WHERE "id" = 'chat-2'
      `),
    ).toEqual([{ from_update: true }]);
  });

  it("mints a token for an invitation 0070 skipped", async () => {
    expect(
      await rows(
        `SELECT "token" IS NOT NULL AS "tokened" FROM "invitation" WHERE "id" = 'inv-1'`,
      ),
    ).toEqual([{ tokened: true }]);
  });

  it("fills the daily-summary cap and the banned flag", async () => {
    expect(
      await rows(
        `SELECT "max_daily_summaries" FROM "workspace" WHERE "id" = 'ws-1'`,
      ),
    ).toEqual([{ max_daily_summaries: 90 }]);
    expect(await rows(`SELECT "banned" FROM "user" WHERE "id" = 'u1'`)).toEqual(
      [{ banned: false }],
    );
  });

  it("fills the fields each Trigger type gained", async () => {
    expect(
      await rows(`SELECT "config" FROM "trigger" WHERE "id" = 'trig-cron'`),
    ).toEqual([
      {
        config: {
          cronExpression: "0 0 * * *",
          timezone: "UTC",
          isOneOff: false,
        },
      },
    ]);
    expect(
      await rows(`SELECT "config" FROM "trigger" WHERE "id" = 'trig-inbound'`),
    ).toEqual([{ config: { inputs: [], tokenExpiryDays: 90 } }]);
  });

  it("runs a second time unchanged", async () => {
    await expect(applyMigration(pg, TAG)).resolves.toBeUndefined();
    expect(
      await rows(`SELECT "config" FROM "trigger" WHERE "id" = 'trig-cron'`),
    ).toEqual([
      {
        config: {
          cronExpression: "0 0 * * *",
          timezone: "UTC",
          isOneOff: false,
        },
      },
    ]);
  });
});

describe("the constraints 0100 adds", () => {
  it("rejects a closed-set value outside the set", async () => {
    await expect(
      pg.exec(`UPDATE "chat" SET "status" = 'bogus' WHERE "id" = 'chat-1'`),
    ).rejects.toThrow(/chat_status_allowed/);
    await expect(
      pg.exec(`UPDATE "trigger" SET "type" = 'bogus' WHERE "id" = 'trig-cron'`),
    ).rejects.toThrow(/trigger_type_allowed/);
    await expect(
      pg.exec(
        `UPDATE "trigger_run" SET "status" = 'bogus' WHERE "id" = 'run-1'`,
      ),
    ).rejects.toThrow(/trigger_run_status_allowed/);
    await expect(
      pg.exec(
        `UPDATE "trigger_run" SET "event_type" = 'bogus' WHERE "id" = 'run-1'`,
      ),
    ).rejects.toThrow(/trigger_run_event_type_allowed/);
    await expect(
      pg.exec(
        `UPDATE "organization" SET "inbound_trigger_gate" = 'bogus' WHERE "id" = 'org-1'`,
      ),
    ).rejects.toThrow(/organization_inbound_trigger_gate_allowed/);
    await expect(
      pg.exec(
        `UPDATE "trigger_run_event" SET "type" = 'bogus' WHERE "id" = 'evt-1'`,
      ),
    ).rejects.toThrow(/trigger_run_event_type_allowed/);
    await expect(
      pg.exec(
        `UPDATE "trigger_run_event" SET "status" = 'bogus' WHERE "id" = 'evt-1'`,
      ),
    ).rejects.toThrow(/trigger_run_event_status_allowed/);
  });

  it("rejects an organization member role outside the set", async () => {
    await pg.exec(`
      INSERT INTO "organization_member" ("id", "organization_id", "user_id", "role")
        VALUES ('m1', 'org-1', 'u1', 'member');
    `);
    await expect(
      pg.exec(
        `UPDATE "organization_member" SET "role" = 'bogus' WHERE "id" = 'm1'`,
      ),
    ).rejects.toThrow(/organization_member_role_allowed/);
  });

  it("rejects a Scoped resource with both scopes", async () => {
    await expect(
      pg.exec(`
        INSERT INTO "provider" ("id", "organization_id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
          VALUES ('p2', 'org-1', 'ws-1', 'Both', 'openai', 'k', 'm', 'm', '[]');
      `),
    ).rejects.toThrow(/provider_scope_exclusive/);
    await expect(
      pg.exec(`
        INSERT INTO "agent" ("id", "organization_id", "workspace_id", "provider_id", "name", "description", "model_id")
          VALUES ('agent-2', 'org-1', 'ws-1', 'p1', 'Both', 'Both', 'm');
      `),
    ).rejects.toThrow(/agent_scope_exclusive/);
    await expect(
      pg.exec(`
        INSERT INTO "mcp" ("id", "organization_id", "workspace_id", "name", "slug", "auth_type")
          VALUES ('mcp-1', 'org-1', 'ws-1', 'Both', 'both', 'none');
      `),
    ).rejects.toThrow(/mcp_scope_exclusive/);
    await expect(
      pg.exec(`
        INSERT INTO "skill" ("id", "organization_id", "workspace_id", "name", "description", "body")
          VALUES ('skill-1', 'org-1', 'ws-1', 'both', 'Both', 'Both');
      `),
    ).rejects.toThrow(/skill_scope_exclusive/);
  });

  it("rejects a Scoped resource with neither scope", async () => {
    await expect(
      pg.exec(`
        INSERT INTO "provider" ("id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
          VALUES ('p3', 'Neither', 'openai', 'k', 'm', 'm', '[]');
      `),
    ).rejects.toThrow(/provider_scope_exclusive/);
    await expect(
      pg.exec(`
        INSERT INTO "agent" ("id", "provider_id", "name", "description", "model_id")
          VALUES ('agent-3', 'p1', 'Neither', 'Neither', 'm');
      `),
    ).rejects.toThrow(/agent_scope_exclusive/);
  });
});

describe("an unrepairable Trigger config", () => {
  const seedBroken = async (
    broken: PGlite,
    type: string,
    config: string,
  ): Promise<void> => {
    await broken.exec(`
      INSERT INTO "user" ("id", "name", "email") VALUES ('u1', 'Jane', 'jane@example.com');
      INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
      INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name") VALUES ('ws-1', 'org-1', 'u1', 'Support');
      INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
        VALUES ('p1', 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]');
      INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id")
        VALUES ('agent-1', 'ws-1', 'p1', 'Helper', 'Helps', 'm');
      INSERT INTO "trigger" ("id", "workspace_id", "agent_id", "type", "name", "instruction", "config")
        VALUES ('trig-broken', 'ws-1', 'agent-1', '${type}', 'Broken', 'Do it', '${config}'::jsonb);
    `);
  };

  it.each([
    [
      "an event config with no events",
      "event",
      '{"filters":{}}',
      /trigger config repair: event trigger trig-broken cannot be repaired/,
    ],
    [
      "an inbound config with too many inputs",
      "inbound",
      '{"inputs":[{"name":"a"},{"name":"b"},{"name":"c"},{"name":"d"},{"name":"e"},{"name":"f"},{"name":"g"},{"name":"h"},{"name":"i"},{"name":"j"},{"name":"k"}],"tokenExpiryDays":90}',
      /trigger config repair: inbound trigger trig-broken cannot be repaired/,
    ],
    [
      "an inbound config whose token lifetime is a string",
      "inbound",
      '{"inputs":[],"tokenExpiryDays":"90"}',
      /trigger config repair: inbound trigger trig-broken cannot be repaired/,
    ],
  ])(
    "stops the migration and names the row for %s",
    async (_case, type, config, message) => {
      const broken = await migratedPglite(TAG);
      try {
        await seedBroken(broken, type, config);
        await expect(applyMigration(broken, TAG)).rejects.toThrow(message);
      } finally {
        await broken.close();
      }
    },
    120_000,
  );
});
