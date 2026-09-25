// @vitest-environment node
import { describe, it, expect } from "vitest";
import { alternativePositions } from "./chat-alternatives";

/**
 * u1 → a1 → u2 → a2, with u2 edited twice (u2b, u2c) and a1 regenerated (a1b),
 * oldest first as the tree arrives.
 */
const tree = [
  { id: "u1", parentId: null },
  { id: "a1", parentId: "u1" },
  { id: "u2", parentId: "a1" },
  { id: "a2", parentId: "u2" },
  { id: "u2b", parentId: "a1" },
  { id: "a1b", parentId: "u1" },
  { id: "u2c", parentId: "a1" },
];

describe("alternativePositions", () => {
  it("places each path message among its Alternatives, oldest first", () => {
    const positions = alternativePositions(tree, ["u1", "a1", "u2b"]);

    expect(positions.get("a1")).toEqual({
      index: 0,
      count: 2,
      previousId: null,
      nextId: "a1b",
    });
    expect(positions.get("u2b")).toEqual({
      index: 1,
      count: 3,
      previousId: "u2",
      nextId: "u2c",
    });
  });

  it("leaves out a message with no Alternatives", () => {
    const positions = alternativePositions(tree, ["u1", "a1", "u2", "a2"]);

    expect([...positions.keys()]).toEqual(["a1", "u2"]);
  });

  it("counts every message opening the Chat as Alternatives", () => {
    const positions = alternativePositions(
      [...tree, { id: "u1b", parentId: null }],
      ["u1b"],
    );

    expect(positions.get("u1b")).toEqual({
      index: 1,
      count: 2,
      previousId: "u1",
      nextId: null,
    });
  });

  // A deleted message is not in the tree, but the messages under it still
  // name it as their parent.
  it("finds Alternatives under a deleted parent", () => {
    const positions = alternativePositions(
      [
        { id: "u1", parentId: null },
        { id: "a1", parentId: "gone" },
        { id: "a1b", parentId: "gone" },
      ],
      ["u1", "a1b"],
    );

    expect(positions.get("a1b")).toMatchObject({ index: 1, count: 2 });
  });

  it("skips a message the tree does not list yet", () => {
    expect(alternativePositions(tree, ["u1", "a1", "streaming"]).size).toBe(1);
  });

  it("reads no tree as no Alternatives", () => {
    expect(alternativePositions(undefined, ["u1"]).size).toBe(0);
  });
});
