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
 * The Provider write model against an in-process Postgres built from the
 * shipped migrations (#1611): an update or delete that fails after it has
 * nullified memory embeddings rolls the nullification back with it.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));

const { updateProvider, deleteProvider } = await import("./provider-write.ts");

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

const workspaceScope = {
  kind: "workspace" as const,
  ctx: { orgId: "org-1", workspaceId: "ws-1" },
};

/**
 * `ws-1` embeds its memory with Provider `p1`, alongside a second Provider
 * `p2`; Jane has one embedded daily summary there.
 */
beforeEach(async () => {
  await pg.exec(`
    DROP TRIGGER IF EXISTS race_agent ON "memory_daily_summary";
    DELETE FROM "agent";
    DELETE FROM "provider";
    DELETE FROM "organization";
    DELETE FROM "user";
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support');
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "embedding_model_id", "embedding_dimensions", "modelIds")
      VALUES
        ('p1', 'ws-1', 'Primary', 'OpenAI', 'k', 'm', 'm', 'embed-small', 3, '[]'),
        ('p2', 'ws-1', 'Secondary', 'OpenAI', 'k', 'm', 'm', NULL, NULL, '[]');
    UPDATE "workspace" SET "memory_embedding_provider_id" = 'p1' WHERE "id" = 'ws-1';
    INSERT INTO "memory_daily_summary" ("id", "user_id", "workspace_id", "summary_date", "summary", "embedding")
      VALUES ('s1', 'u1', 'ws-1', '2026-10-01', 'Talked about orders', '{0.1,0.2,0.3}');
  `);
});

const UNIQUE_VIOLATION = "23505";
// ON DELETE RESTRICT reports restrict_violation, not foreign_key_violation.
const RESTRICT_VIOLATION = "23001";

const embeddings = async () =>
  (
    await pg.query<{ embedding: unknown }>(
      `SELECT "embedding" FROM "memory_daily_summary" ORDER BY "id"`,
    )
  ).rows.map((r) => r.embedding);

const provider = async (id: string) =>
  (
    await pg.query<{ name: string; embedding_model_id: string | null }>(
      `SELECT "name", "embedding_model_id" FROM "provider" WHERE "id" = $1`,
      [id],
    )
  ).rows;

describe("updateProvider", () => {
  it("keeps embeddings and the Provider row when an embedding-model change fails on a duplicate name", async () => {
    await expect(
      updateProvider(workspaceScope, "p1", {
        name: "Secondary",
        providerType: "OpenAI",
        apiKey: "k",
        apiMode: "responses",
        searchSource: "native",
        modelIds: [],
        taskModelId: "m",
        memoryExtractionModelId: "m",
        embeddingModelId: "embed-large",
      }),
    ).rejects.toMatchObject({ cause: { code: UNIQUE_VIOLATION } });

    expect(await embeddings()).not.toContain(null);
    expect(await provider("p1")).toEqual([
      { name: "Primary", embedding_model_id: "embed-small" },
    ]);
  });
});

describe("deleteProvider", () => {
  // Stands in for an Agent created concurrently: it lands once the embeddings
  // are nullified, so the delete trips the agent.provider_id ON DELETE
  // RESTRICT key after the in-use check has already passed.
  const raceAnAgentIn = () =>
    pg.exec(`
      CREATE OR REPLACE FUNCTION race_agent() RETURNS trigger AS $$
      BEGIN
        INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id")
          VALUES ('late', 'ws-1', 'p1', 'Late', 'Late', 'm');
        RETURN NULL;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER race_agent AFTER UPDATE ON "memory_daily_summary"
        FOR EACH STATEMENT EXECUTE FUNCTION race_agent();
    `);

  it("keeps embeddings and the Provider row when the delete fails on an Agent created after the in-use check", async () => {
    await raceAnAgentIn();

    await expect(deleteProvider(workspaceScope, "p1")).rejects.toMatchObject({
      cause: { code: RESTRICT_VIOLATION },
    });

    expect(await embeddings()).not.toContain(null);
    expect(await provider("p1")).toHaveLength(1);
  });

  it("keeps embeddings and a Shared Provider row when an Organization-scope delete fails the same way", async () => {
    await pg.exec(`
      UPDATE "provider" SET "organization_id" = 'org-1', "workspace_id" = NULL
        WHERE "id" = 'p1';
    `);
    await raceAnAgentIn();

    await expect(
      deleteProvider({ kind: "organization", orgId: "org-1" }, "p1"),
    ).rejects.toMatchObject({ cause: { code: RESTRICT_VIOLATION } });

    expect(await embeddings()).not.toContain(null);
    expect(await provider("p1")).toHaveLength(1);
  });
});
