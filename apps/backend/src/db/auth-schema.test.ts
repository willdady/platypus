import { describe, it, expect } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { getSchema } from "better-auth/db";
import { authPlugins, authUserFieldOverrides } from "../auth-plugins.ts";
import * as authSchema from "./auth-schema.ts";

describe("the Drizzle auth schema covers what better-auth expects", () => {
  const expected = getSchema({
    plugins: authPlugins,
    user: { additionalFields: authUserFieldOverrides },
  });

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

  it("makes the admin plugin's banned field required, so regeneration keeps NOT NULL", () => {
    expect(expected.user.fields.banned.required).toBe(true);
    const banned = getTableColumns(authSchema.user).banned;
    expect(banned.notNull).toBe(true);
  });
});
