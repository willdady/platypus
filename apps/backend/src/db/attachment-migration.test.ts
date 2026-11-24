import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  applyMigration,
  migratedPglite,
} from "./migrated-pglite.test-fixtures.ts";

const TABLE_MIGRATION = "0039_stale_red_wolf";
const BACKFILL_MIGRATION = "0040_backfill_org_attachments";

type AttachmentRow = {
  workspace_id: string;
  resource_type: string;
  resource_id: string;
};

const selectAttachments = async (pg: PGlite) => {
  const { rows } = await pg.query<AttachmentRow>(
    `SELECT "workspace_id", "resource_type", "resource_id"
       FROM "attachment"
       ORDER BY "resource_type", "resource_id", "workspace_id"`,
  );
  return rows;
};

let pg: PGlite;
let afterBackfill: AttachmentRow[];
beforeAll(async () => {
  // why: migrate only up to the backfill so the seed reflects a pre-Attachment database.
  pg = await migratedPglite(BACKFILL_MIGRATION);
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email")
      VALUES ('u1', 'Jane', 'jane@example.com'), ('u2', 'John', 'john@example.com');
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme'), ('org-2', 'Globex');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1a', 'org-1', 'u1', 'Acme Support'),
             ('ws-1b', 'org-1', 'u1', 'Acme Sales'),
             ('ws-2a', 'org-2', 'u2', 'Globex Ops'),
             ('ws-2b', 'org-2', 'u2', 'Globex Billing');
    INSERT INTO "provider" ("id", "organization_id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('p-org-1', 'org-1', NULL, 'P', 'openai', 'k', 'm', 'm', '[]'),
             ('p-org-2', 'org-2', NULL, 'P', 'openai', 'k', 'm', 'm', '[]'),
             ('p-ws-1a', NULL, 'ws-1a', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "mcp" ("id", "organization_id", "workspace_id", "name", "url", "auth_type")
      VALUES ('m-org-1', 'org-1', NULL, 'M', 'https://m.example.com', 'none'),
             ('m-org-2', 'org-2', NULL, 'M', 'https://m.example.com', 'none'),
             ('m-ws-2a', NULL, 'ws-2a', 'M', 'https://m.example.com', 'none');
  `);
}, 120_000);
afterAll(() => pg.close());

describe(TABLE_MIGRATION, () => {
  it("creates the Attachment table with its unique constraint", async () => {
    const { rows } = await pg.query<{ conname: string }>(
      `SELECT "conname" FROM "pg_constraint"
         WHERE "conrelid" = 'attachment'::regclass AND "contype" = 'u'`,
    );
    expect(rows.map((r) => r.conname)).toEqual(["unique_attachment"]);
  });

  it("inserts no Attachment rows of its own", async () => {
    expect(await selectAttachments(pg)).toEqual([]);
  });
});

describe(BACKFILL_MIGRATION, () => {
  beforeAll(async () => {
    await applyMigration(pg, BACKFILL_MIGRATION);
    afterBackfill = await selectAttachments(pg);
  }, 120_000);

  it("attaches each Shared Provider to every Workspace in its Organization", () => {
    expect(afterBackfill.filter((r) => r.resource_type === "provider")).toEqual(
      [
        {
          workspace_id: "ws-1a",
          resource_type: "provider",
          resource_id: "p-org-1",
        },
        {
          workspace_id: "ws-1b",
          resource_type: "provider",
          resource_id: "p-org-1",
        },
        {
          workspace_id: "ws-2a",
          resource_type: "provider",
          resource_id: "p-org-2",
        },
        {
          workspace_id: "ws-2b",
          resource_type: "provider",
          resource_id: "p-org-2",
        },
      ],
    );
  });

  it("attaches each Shared MCP to every Workspace in its Organization", () => {
    expect(afterBackfill.filter((r) => r.resource_type === "mcp")).toEqual([
      { workspace_id: "ws-1a", resource_type: "mcp", resource_id: "m-org-1" },
      { workspace_id: "ws-1b", resource_type: "mcp", resource_id: "m-org-1" },
      { workspace_id: "ws-2a", resource_type: "mcp", resource_id: "m-org-2" },
      { workspace_id: "ws-2b", resource_type: "mcp", resource_id: "m-org-2" },
    ]);
  });

  it("leaves Workspace-scoped Providers and MCPs unattached", () => {
    const attachedIds = new Set(afterBackfill.map((r) => r.resource_id));
    expect(attachedIds.has("p-ws-1a")).toBe(false);
    expect(attachedIds.has("m-ws-2a")).toBe(false);
  });

  it("is idempotent when applied a second time", async () => {
    await expect(
      applyMigration(pg, BACKFILL_MIGRATION),
    ).resolves.toBeUndefined();
    expect(await selectAttachments(pg)).toEqual(afterBackfill);
  });
});
