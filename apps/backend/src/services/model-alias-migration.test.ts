import { describe, it, expect, beforeEach } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import type { ModelConfig } from "@platypus/schemas";

import {
  orphanedAliasRepoints,
  deMigrateOrphanedAliases,
} from "./model-alias-migration.ts";

const model = (
  id: string,
  alias?: string,
): ModelConfig & { alias?: string } => ({
  id,
  passthroughFileTypes: [],
  ...(alias ? { alias } : {}),
});

describe("orphanedAliasRepoints", () => {
  it("finds nothing when the alias set is unchanged", () => {
    const before = [model("gpt-4", "flagship"), model("gpt-3.5")];
    expect(orphanedAliasRepoints(before, before)).toEqual([]);
  });

  it("finds nothing when no alias existed before", () => {
    expect(
      orphanedAliasRepoints([model("gpt-4")], [model("gpt-4", "flagship")]),
    ).toEqual([]);
  });

  it("reports an alias that was cleared, pointing at its entry's id", () => {
    expect(
      orphanedAliasRepoints([model("gpt-4", "flagship")], [model("gpt-4")]),
    ).toEqual([{ alias: "flagship", modelId: "gpt-4" }]);
  });

  it("reports a renamed alias under its OLD name", () => {
    // An alias has no identity apart from its name, so a rename is a delete
    // plus a create — every `alias:flagship` reference is now dangling.
    expect(
      orphanedAliasRepoints(
        [model("gpt-4", "flagship")],
        [model("gpt-4", "premier")],
      ),
    ).toEqual([{ alias: "flagship", modelId: "gpt-4" }]);
  });

  it("treats a case-only rename as no change, matching how references resolve", () => {
    // `alias:flagship` still resolves to `Flagship` — nothing is orphaned.
    expect(
      orphanedAliasRepoints(
        [model("gpt-4", "flagship")],
        [model("gpt-4", "Flagship")],
      ),
    ).toEqual([]);
  });

  it("treats moving an alias to another entry as a repoint, not an orphaning", () => {
    expect(
      orphanedAliasRepoints(
        [model("gpt-4", "flagship"), model("gpt-3.5")],
        [model("gpt-4"), model("gpt-3.5", "flagship")],
      ),
    ).toEqual([]);
  });

  it("skips an alias whose model entry was deleted in the same save", () => {
    // No concrete id to fall back to — this is the pre-existing dangling-id
    // case, and inventing a different model would be worse than failing.
    expect(
      orphanedAliasRepoints([model("gpt-4", "flagship")], [model("gpt-3.5")]),
    ).toEqual([]);
  });

  it("reports several orphaned aliases at once", () => {
    expect(
      orphanedAliasRepoints(
        [model("gpt-4", "flagship"), model("gpt-3.5", "fast")],
        [model("gpt-4"), model("gpt-3.5")],
      ),
    ).toEqual([
      { alias: "flagship", modelId: "gpt-4" },
      { alias: "fast", modelId: "gpt-3.5" },
    ]);
  });

  it("tolerates a legacy string[] on either side", () => {
    const legacy = ["gpt-4"] as unknown as ModelConfig[];
    expect(orphanedAliasRepoints(legacy, [model("gpt-4", "flagship")])).toEqual(
      [],
    );
    expect(orphanedAliasRepoints([model("gpt-4", "flagship")], legacy)).toEqual(
      [{ alias: "flagship", modelId: "gpt-4" }],
    );
  });
});

describe("deMigrateOrphanedAliases", () => {
  beforeEach(() => {
    resetMockDb();
  });

  it("writes nothing and reports nothing when no alias was orphaned", async () => {
    const report = await deMigrateOrphanedAliases(
      "p1",
      [model("gpt-4", "flagship")],
      [model("gpt-4", "flagship")],
    );

    expect(report).toEqual([]);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("rewrites Agents and Chats back to the concrete id and counts each", async () => {
    mockDb.returning
      .mockResolvedValueOnce([{ id: "a1" }, { id: "a2" }, { id: "a3" }])
      .mockResolvedValueOnce([{ id: "c1" }]);

    const report = await deMigrateOrphanedAliases(
      "p1",
      [model("gpt-4", "flagship")],
      [model("gpt-4")],
    );

    expect(report).toEqual([
      { alias: "flagship", modelId: "gpt-4", agents: 3, chats: 1 },
    ]);
    expect(mockDb.update).toHaveBeenCalledTimes(2);
    expect(mockDb.set).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "gpt-4" }),
    );
  });

  it("reports zero counts when the orphaned alias had no references", async () => {
    mockDb.returning.mockResolvedValue([]);

    const report = await deMigrateOrphanedAliases(
      "p1",
      [model("gpt-4", "flagship")],
      [model("gpt-4")],
    );

    expect(report).toEqual([
      { alias: "flagship", modelId: "gpt-4", agents: 0, chats: 0 },
    ]);
  });
});
