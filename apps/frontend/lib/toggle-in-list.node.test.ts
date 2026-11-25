import { describe, it, expect } from "vitest";
import { toggleInList } from "./toggle-in-list";

describe("toggleInList", () => {
  it("adds the id when it is turned on", () => {
    expect(toggleInList(["a"], "b", true)).toEqual(["a", "b"]);
  });

  it("removes the id when it is turned off", () => {
    expect(toggleInList(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("returns the same list when it already holds the id", () => {
    const list = ["a", "b"];

    expect(toggleInList(list, "a", true)).toBe(list);
  });

  it("returns the same list when it does not hold the id", () => {
    const list = ["a"];

    expect(toggleInList(list, "b", false)).toBe(list);
  });

  it("does not mutate the list it is given", () => {
    const list = ["a"];
    toggleInList(list, "b", true);
    toggleInList(list, "a", false);

    expect(list).toEqual(["a"]);
  });
});
