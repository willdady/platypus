import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const drizzleDir = new URL("../../drizzle/", import.meta.url);
const tags = (
  JSON.parse(
    readFileSync(new URL("meta/_journal.json", drizzleDir), "utf8"),
  ) as { entries: { tag: string }[] }
).entries.map((e) => e.tag);

export const applyMigration = async (pg: PGlite, tag: string) => {
  const sql = readFileSync(new URL(`${tag}.sql`, drizzleDir), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    await pg.exec(statement);
  }
};

export const migratedPglite = async (until?: string): Promise<PGlite> => {
  const pg = await PGlite.create();
  // why: PGlite bundles no pgvector; the migrations only name the type
  await pg.exec("CREATE DOMAIN vector AS real[]");
  for (const tag of tags) {
    if (tag === until) break;
    await applyMigration(pg, tag);
  }
  return pg;
};
