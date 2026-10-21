import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * Writing the retired Provider-type default into every model entry that was
 * inheriting it (#1594, ADR-0039), run for real against an in-process Postgres
 * over `provider` cut down to the columns the migration touches.
 */
const migration = readFileSync(
  new URL(
    "../../drizzle/0091_backfill_passthrough_file_types.sql",
    import.meta.url,
  ),
  "utf8",
);

let db: PGlite;
beforeAll(async () => {
  db = await PGlite.create();
}, 60_000);
afterAll(() => db.close());

type Row = { id: string; type: string; apiMode: string; models: unknown[] };

/** Applies the migration over these Providers, returning each one's models. */
const migrate = async (providers: Row[]) => {
  await db.exec(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    CREATE TABLE "provider" (
      "id" text PRIMARY KEY,
      "provider_type" text NOT NULL,
      "api_mode" text DEFAULT 'responses' NOT NULL,
      "modelIds" jsonb NOT NULL
    );
  `);
  for (const p of providers) {
    await db.query(`INSERT INTO "provider" VALUES ($1, $2, $3, $4)`, [
      p.id,
      p.type,
      p.apiMode,
      JSON.stringify(p.models),
    ]);
  }
  await db.exec(migration);
  const { rows } = await db.query<{ id: string; modelIds: unknown[] }>(
    `SELECT "id", "modelIds" FROM "provider" ORDER BY "id"`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.modelIds]));
};

const IMAGES_PDF = ["image/*", "application/pdf"];

describe("0091 passthrough file types backfill", () => {
  it("writes each Provider type's old default into entries that declare none", async () => {
    expect(
      await migrate([
        {
          id: "anthropic",
          type: "Anthropic",
          apiMode: "responses",
          models: [
            { id: "b", passthroughFileTypes: [] },
            { id: "a", alias: "fast", maxOutputTokens: 100 },
          ],
        },
        {
          id: "google",
          type: "Google",
          apiMode: "responses",
          models: [{ id: "g", passthroughFileTypes: [] }],
        },
        {
          id: "bedrock",
          type: "Bedrock",
          apiMode: "responses",
          models: [{ id: "br", passthroughFileTypes: [] }],
        },
        {
          id: "openai-chat",
          type: "OpenAI",
          apiMode: "chat",
          models: [{ id: "c", passthroughFileTypes: [] }],
        },
        {
          id: "openai-responses",
          type: "OpenAI",
          apiMode: "responses",
          models: [{ id: "r", passthroughFileTypes: [] }],
        },
        {
          id: "openrouter",
          type: "OpenRouter",
          apiMode: "responses",
          models: [{ id: "o", passthroughFileTypes: [] }],
        },
      ]),
    ).toEqual({
      anthropic: [
        { id: "b", passthroughFileTypes: IMAGES_PDF },
        {
          id: "a",
          alias: "fast",
          maxOutputTokens: 100,
          passthroughFileTypes: IMAGES_PDF,
        },
      ],
      google: [{ id: "g", passthroughFileTypes: IMAGES_PDF }],
      bedrock: [{ id: "br", passthroughFileTypes: IMAGES_PDF }],
      "openai-chat": [{ id: "c", passthroughFileTypes: ["image/*"] }],
      "openai-responses": [{ id: "r", passthroughFileTypes: IMAGES_PDF }],
      openrouter: [{ id: "o", passthroughFileTypes: [] }],
    });
  });

  it("leaves declared entries alone and turns bare strings into objects", async () => {
    expect(
      await migrate([
        {
          id: "anthropic",
          type: "Anthropic",
          apiMode: "responses",
          models: [{ id: "declared", passthroughFileTypes: ["*/*"] }, "legacy"],
        },
        {
          id: "openrouter",
          type: "OpenRouter",
          apiMode: "responses",
          models: ["legacy"],
        },
      ]),
    ).toEqual({
      anthropic: [
        { id: "declared", passthroughFileTypes: ["*/*"] },
        { id: "legacy", passthroughFileTypes: IMAGES_PDF },
      ],
      openrouter: [{ id: "legacy", passthroughFileTypes: [] }],
    });
  });
});
