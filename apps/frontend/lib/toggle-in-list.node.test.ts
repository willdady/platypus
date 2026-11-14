import { describe, it, expect } from "vitest";
import { toggleInList } from "./toggle-in-list";

describe("toggleInList", () => {
  it("adds the id when it is turned on", () => {
    expect(toggleInList(["a"], "b", true)).toEqual(["a", "b"]);
  });

  it("removes the id when it is turned off", () => {
    expect(toggleInList(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("keeps a list that already holds the id", () => {
    expect(toggleInList(["a", "b"], "a", true)).toEqual(["a", "b"]);
  });

  it("keeps a list that does not hold the id", () => {
    expect(toggleInList(["a"], "b", false)).toEqual(["a"]);
  });

  it("does not mutate the list it is given", () => {
    const list = ["a"];
    toggleInList(list, "b", true);
    toggleInList(list, "a", false);

    expect(list).toEqual(["a"]);
  });
});
