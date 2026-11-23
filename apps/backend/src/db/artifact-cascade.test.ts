import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPglite } from "./migrated-pglite.test-fixtures.ts";

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "chat" ("id", "workspace_id", "title")
      VALUES ('chat-1', 'ws-1', 'Source'), ('chat-2', 'ws-1', 'Later');
  `);
}, 60_000);
afterAll(() => pg.close());

const count = async (table: string) =>
  (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`))
    .rows[0].n;

const artifactWithVersion = (id: string, chatId = "chat-1") =>
  pg.exec(`
    INSERT INTO "artifact" ("id", "workspace_id", "source_chat_id", "title", "type")
      VALUES ('${id}', 'ws-1', '${chatId}', 'Plan', 'markdown');
    INSERT INTO "artifact_version" ("id", "artifact_id", "version", "content", "author")
      VALUES ('${id}-v1', '${id}', 1, 'Body', 'agent');
  `);

describe("Artifact foreign keys", () => {
  it("keeps the Artifact and clears its source when the Chat is deleted", async () => {
    await artifactWithVersion("a1");
    await pg.exec(`DELETE FROM "chat" WHERE "id" = 'chat-1'`);

    const { rows } = await pg.query<{ source_chat_id: string | null }>(
      `SELECT "source_chat_id" FROM "artifact" WHERE "id" = 'a1'`,
    );
    expect(rows).toEqual([{ source_chat_id: null }]);
    expect(await count("artifact_version")).toBe(1);
  });

  it("refuses two rows for one version number", async () => {
    await expect(
      pg.exec(`
        INSERT INTO "artifact_version" ("id", "artifact_id", "version", "content", "author")
          VALUES ('a1-again', 'a1', 1, 'Other', 'user');
      `),
    ).rejects.toThrow(/unique_artifact_version/);
  });

  it("deletes the Artifact and its versions with the Workspace", async () => {
    await artifactWithVersion("a2", "chat-2");
    await pg.exec(`DELETE FROM "workspace" WHERE "id" = 'ws-1'`);

    expect(await count("artifact")).toBe(0);
    expect(await count("artifact_version")).toBe(0);
  });
});
