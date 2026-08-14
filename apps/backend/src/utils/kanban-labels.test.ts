import { describe, it, expect } from "vitest";
import { filterKnownLabelIds, pruneCardLabelIds } from "./kanban-labels.ts";

describe("filterKnownLabelIds", () => {
  it("keeps every submitted ID when all are known", () => {
    expect(filterKnownLabelIds(["a", "b"], ["a", "b", "c"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("preserves the submitted order", () => {
    expect(filterKnownLabelIds(["c", "a"], ["a", "b", "c"])).toEqual([
      "c",
      "a",
    ]);
  });

  it("drops IDs that are not on the board", () => {
    expect(filterKnownLabelIds(["stale", "b"], ["a", "b"])).toEqual(["b"]);
  });

  it("returns an empty list when every submitted ID is unknown", () => {
    expect(filterKnownLabelIds(["stale"], ["a"])).toEqual([]);
  });

  it("returns an empty list when the board has no labels", () => {
    expect(filterKnownLabelIds(["a"], [])).toEqual([]);
  });
});

describe("pruneCardLabelIds", () => {
  it("returns only the cards holding an unknown ID", () => {
    const pruned = pruneCardLabelIds(
      [
        { id: "card-1", labelIds: ["a", "stale"] },
        { id: "card-2", labelIds: ["a"] },
        { id: "card-3", labelIds: [] },
      ],
      ["a", "b"],
    );
    expect(pruned).toEqual([{ id: "card-1", labelIds: ["a"] }]);
  });

  it("empties the label list of every card when no labels remain", () => {
    const pruned = pruneCardLabelIds(
      [
        { id: "card-1", labelIds: ["a"] },
        { id: "card-2", labelIds: ["a", "b"] },
      ],
      [],
    );
    expect(pruned).toEqual([
      { id: "card-1", labelIds: [] },
      { id: "card-2", labelIds: [] },
    ]);
  });

  it("returns nothing when every card only holds known IDs", () => {
    expect(
      pruneCardLabelIds([{ id: "card-1", labelIds: ["a"] }], ["a", "b"]),
    ).toEqual([]);
  });

  it("never adds an ID a card did not already hold", () => {
    const pruned = pruneCardLabelIds(
      [{ id: "card-1", labelIds: ["stale"] }],
      ["a", "b"],
    );
    expect(pruned).toEqual([{ id: "card-1", labelIds: [] }]);
  });
});
