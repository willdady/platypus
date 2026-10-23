import { describe, it, expect, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { databaseConfig } from "./connection-config.ts";

/**
 * Every connection the backend opens runs in UTC, whatever the database's own
 * default, so `defaultNow()` and a JS-written `Date` store the same instant
 * (#1615).
 */
const stamp = pgTable("stamp", {
  id: text("id").primaryKey(),
  at: timestamp("at").notNull().defaultNow(),
});

let pg: PGlite | undefined;
afterEach(async () => {
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
      "postgres://u:p@db:5432/platypus?options=-c%20search_path%3Dpublic",
    );

    const { rows } = await pg.query<{ TimeZone: string }>("SHOW TimeZone");
    expect(rows[0].TimeZone).toBe("UTC");
    expect(
      databaseConfig(
        "postgres://u:p@db:5432/platypus?options=-c%20search_path%3Dpublic",
      ).options,
    ).toContain("-c search_path=public");
  });

  it("leaves the connection to node-postgres' PG* defaults without a URL", () => {
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
