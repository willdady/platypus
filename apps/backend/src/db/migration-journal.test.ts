import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

type JournalEntry = { idx: number; when: number; tag: string };

const journal = JSON.parse(
  readFileSync(
    new URL("../../drizzle/meta/_journal.json", import.meta.url),
    "utf8",
  ),
) as { entries: JournalEntry[] };

// why: shipped out of order; never add here, regenerate the migration on a rebased branch
const shippedOutOfOrder: Record<string, string> = {
  "0065_sparkling_frightful_four": "0068_reapply_skill_invocation_columns",
};

describe("migration journal", () => {
  it("numbers entries contiguously from zero", () => {
    expect(journal.entries.map((e) => e.idx)).toEqual(
      journal.entries.map((_, i) => i),
    );
  });

  it("orders every new entry's `when` after all earlier ones", () => {
    let newest = -Infinity;
    for (const entry of journal.entries) {
      if (entry.tag in shippedOutOfOrder) {
        expect(
          journal.entries.some((e) => e.tag === shippedOutOfOrder[entry.tag]),
        ).toBe(true);
        continue;
      }
      expect(
        entry.when,
        `${entry.tag} is timestamped before an earlier migration; databases that already ran the newer one will never apply it`,
      ).toBeGreaterThan(newest);
      newest = Math.max(newest, entry.when);
    }
  });
});
