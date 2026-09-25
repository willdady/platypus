import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getSchema } from "better-auth/db";
import { authPlugins } from "../auth-plugins.ts";
import * as authSchema from "./auth-schema.ts";

/**
 * `auth-schema.ts` is generated, and a better-auth upgrade or a new plugin can
 * expect a column it does not carry — `session.impersonatedBy`, which the
 * `admin` plugin has always declared, was missing until better-auth 1.7 began
 * validating the Drizzle schema at startup and sign-in broke.
 *
 * better-auth's own `getSchema` is the authority on what the configured
 * plugins expect, so this compares against that rather than a hand-copied
 * list: the same drift fails here instead of at a developer's next sign-in.
 */
describe("the Drizzle auth schema covers what better-auth expects", () => {
  const expected = getSchema({ plugins: authPlugins });

  const drizzleFieldsFor = (table: string) => {
    const drizzleTable = (authSchema as Record<string, unknown>)[table];
    if (!drizzleTable) return undefined;
    return new Set(
      Object.keys(
        getTableColumns(drizzleTable as Parameters<typeof getTableColumns>[0]),
      ),
    );
  };

  it.each(
    Object.entries(expected).map(([table, def]) => ({
      table,
      fields: Object.keys(def.fields),
    })),
  )(
    "declares $table with every field better-auth expects",
    ({ table, fields }) => {
      const present = drizzleFieldsFor(table);
      expect(present).toBeDefined();
      expect(fields.filter((field) => !present?.has(field))).toEqual([]);
    },
  );

  it("carries the admin plugin's impersonatedBy on session", () => {
    expect(drizzleFieldsFor("session")).toContain("impersonatedBy");
  });
});
