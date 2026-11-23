import { describe, expect, it } from "vitest";
import { db } from "./index.ts";
import { eq } from "drizzle-orm";
import { workspace as workspaceTable } from "./db/schema.ts";

describe("the fake db installed by the vitest setup", () => {
  it("serves a seeded row when the test utilities arrive after the module under test", async () => {
    const { resetMockDb, seedDb } = await import("./test-utils.ts");
    resetMockDb();
    seedDb({
      workspace: [{ id: "ws-1", name: "Alpha", organizationId: "org-1" }],
    });

    const found = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, "ws-1"))
      .limit(1);

    expect(found).toEqual([expect.objectContaining({ name: "Alpha" })]);
  });
});
