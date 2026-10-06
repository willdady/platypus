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
import { hashBearerToken } from "./bearer-token.ts";
import { NotFoundError } from "../errors.ts";

/**
 * Regenerating an A2A token is one `UPDATE … FROM a2a_endpoint` (#1301): the
 * Workspace check and the lifetime it keeps are real SQL here.
 */
const { holder } = vi.hoisted(() => ({
  holder: { db: undefined as ReturnType<typeof drizzle> | undefined },
}));
vi.mock("../index.ts", () => ({
  get db() {
    return holder.db!;
  },
}));

const { regenerateA2aToken } = await import("./a2a-token.ts");

const DAY = 24 * 60 * 60 * 1000;

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedPglite();
  await pg.exec(`
    INSERT INTO "user" ("id", "name", "email", "email_verified", "created_at", "updated_at")
      VALUES ('u1', 'Jane', 'jane@example.com', true, now(), now());
    INSERT INTO "organization" ("id", "name") VALUES ('org-1', 'Acme');
    INSERT INTO "workspace" ("id", "organization_id", "owner_id", "name")
      VALUES ('ws-1', 'org-1', 'u1', 'Support'),
             ('ws-2', 'org-1', 'u1', 'Other');
    INSERT INTO "provider" ("id", "workspace_id", "name", "provider_type", "api_key", "task_model_id", "memory_extraction_model_id", "modelIds")
      VALUES ('p1', 'ws-1', 'P', 'openai', 'k', 'm', 'm', '[]');
    INSERT INTO "agent" ("id", "workspace_id", "provider_id", "name", "description", "model_id")
      VALUES ('agent-1', 'ws-1', 'p1', 'Helper', 'Helps', 'm');
    INSERT INTO "a2a_endpoint" ("id", "workspace_id", "agent_id", "name", "description")
      VALUES ('ep-1', 'ws-1', 'agent-1', 'Helper', 'Helps');
  `);
  holder.db = drizzle(pg);
}, 60_000);
afterAll(() => pg.close());

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "a2a_token";
    INSERT INTO "a2a_token" ("id", "endpoint_id", "name", "token_hash", "token_created_at", "token_expires_at", "token_notice")
      VALUES ('tok-1', 'ep-1', 'Hermes', 'h', '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z', 'expired');
  `);
});

const stored = async () =>
  (
    await pg.query<{ token_hash: string; token_notice: string | null }>(
      `SELECT "token_hash", "token_notice" FROM "a2a_token" WHERE "id" = 'tok-1'`,
    )
  ).rows[0];

describe("regenerateA2aToken", () => {
  it("issues a new value with the lifetime the token had, from now", async () => {
    const before = Date.now();

    const regenerated = await regenerateA2aToken("ws-1", "ep-1", "tok-1");

    expect(regenerated).toMatchObject({ id: "tok-1", name: "Hermes" });
    const row = await stored();
    expect(row.token_hash).toBe(hashBearerToken(regenerated.token));
    expect(row.token_notice).toBeNull();
    // Read back through Drizzle, which takes the stored times as UTC, so an
    // expiry written in the session's time zone would be hours off.
    const created = regenerated.tokenCreatedAt.getTime();
    expect(created).toBeGreaterThanOrEqual(before);
    expect(created).toBeLessThanOrEqual(Date.now());
    expect(regenerated.tokenExpiresAt.getTime() - created).toBe(30 * DAY);
  });

  it("leaves the token alone when the endpoint is in another Workspace", async () => {
    await expect(
      regenerateA2aToken("ws-2", "ep-1", "tok-1"),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect((await stored()).token_hash).toBe("h");
  });
});
