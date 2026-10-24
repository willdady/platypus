import { describe, it, expect, afterEach, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { databaseConfig, buildPoolConfig } from "./connection-config.ts";

/**
 * The app's and the migration runner's connections run in UTC, whatever the database's own
 * default, so `defaultNow()` and a JS-written `Date` store the same instant
 * (#1615).
 */
const stamp = pgTable("stamp", {
  id: text("id").primaryKey(),
  at: timestamp("at").notNull().defaultNow(),
});

let pg: PGlite | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await pg?.close();
  pg = undefined;
});

/**
 * Opens a session the way Postgres does for a client sending `options`: the
 * database default first, then each `-c name=value` on top.
 */
const connect = async (databaseTimeZone: string, url: string) => {
  pg = await PGlite.create();
  await pg.exec(`SET TimeZone = '${databaseTimeZone}'`);
  const { options = "" } = databaseConfig(url);
  for (const [, name, value] of options.matchAll(/-c\s+(\w+)=(\S+)/g)) {
    await pg.exec(`SET ${name} = '${value}'`);
  }
  await pg.exec(
    `CREATE TABLE "stamp" ("id" text PRIMARY KEY, "at" timestamp NOT NULL DEFAULT now())`,
  );
  return { pg, db: drizzle(pg) };
};

describe("databaseConfig", () => {
  it("stores a defaultNow() and a JS-written Date for one instant alike on a non-UTC database", async () => {
    const { db } = await connect(
      "Australia/Sydney",
      "postgres://u:p@db:5432/platypus",
    );

    const before = Date.now();
    await db.insert(stamp).values({ id: "db" });
    await db.insert(stamp).values({ id: "js", at: new Date() });
    const after = Date.now();

    const [fromDb] = await db.select().from(stamp).where(eq(stamp.id, "db"));
    const [fromJs] = await db.select().from(stamp).where(eq(stamp.id, "js"));
    expect(fromDb.at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(fromDb.at.getTime()).toBeLessThanOrEqual(after + 1000);
    expect(Math.abs(fromDb.at.getTime() - fromJs.at.getTime())).toBeLessThan(
      1000,
    );
  });

  it("keeps the pin when the URL carries its own options", async () => {
    const { pg } = await connect(
      "Australia/Sydney",
      "postgres://u:p@db:5432/platypus?options=-c%20search_path%3Dpg_catalog",
    );

    const timeZone = await pg.query<{ TimeZone: string }>("SHOW TimeZone");
    expect(timeZone.rows[0].TimeZone).toBe("UTC");
    const searchPath = await pg.query<{ search_path: string }>(
      "SHOW search_path",
    );
    expect(searchPath.rows[0].search_path).toBe("pg_catalog");
  });

  it("leaves the connection to node-postgres' PG* defaults without a URL", () => {
    vi.stubEnv("PGOPTIONS", undefined);
    expect(databaseConfig(undefined)).toEqual({ options: "-c TimeZone=UTC" });
  });

  it("connects to the database the URL names", () => {
    expect(
      databaseConfig("postgres://alice:s3cret@db.internal:6543/platypus"),
    ).toMatchObject({
      user: "alice",
      password: "s3cret",
      host: "db.internal",
      port: 6543,
      database: "platypus",
    });
  });
});

describe("buildPoolConfig", () => {
  it("sets the pool size and every connection guard explicitly", () => {
    expect(buildPoolConfig(undefined, 10)).toEqual({
      options: "-c TimeZone=UTC",
      max: 10,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 600_000,
      idle_in_transaction_session_timeout: 60_000,
    });
  });

  it("keeps the URL parse and the UTC pin", () => {
    expect(
      buildPoolConfig("postgres://alice:s3cret@db.internal:6543/platypus", 3),
    ).toMatchObject({
      user: "alice",
      host: "db.internal",
      port: 6543,
      database: "platypus",
      max: 3,
      options: "-c TimeZone=UTC",
    });
  });
});
