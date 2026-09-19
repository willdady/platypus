import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

type JournalEntry = { idx: number; when: number; tag: string };

const journal = JSON.parse(
  readFileSync(
    new URL("../../drizzle/meta/_journal.json", import.meta.url),
    "utf8",
  ),
) as { entries: JournalEntry[] };

/**
 * Drizzle's migrator reads the newest `created_at` recorded in the database
 * once, then applies only the journal entries whose `when` is later than it.
 * A migration generated on a branch before an earlier-numbered one merged
 * carries an older `when`, and every database that already ran the newer
 * neighbour skips it for good — which is how 3.7.0 shipped a backend selecting
 * two `skill` columns that 3.6.0 upgraders never received (0065, re-applied by
 * 0068). Fresh databases apply everything, so nothing local ever notices.
 *
 * Entries listed here are the ones that already shipped out of order; each
 * names the migration that re-applies it. Nothing may be added to this list —
 * regenerate the migration on a branch rebased onto `main` instead.
 */
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
