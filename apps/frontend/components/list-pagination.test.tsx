import { describe, expect, it } from "vitest";
import { pageOf } from "./list-pagination";

const items = ["a", "b", "c", "d", "e"];

describe("pageOf ghosts", () => {
  it("fills a short last page out to a full one", () => {
    expect(pageOf("2", items, 3)).toMatchObject({
      items: ["d", "e"],
      ghosts: 1,
    });
  });

  it("adds none to a full page", () => {
    expect(pageOf("1", items, 3).ghosts).toBe(0);
  });

  it("adds none when there is only one page", () => {
    expect(pageOf(null, items.slice(0, 2), 3).ghosts).toBe(0);
  });

  it("completes a lone page's half-full last row", () => {
    expect(pageOf(null, items.slice(0, 3), 4)).toMatchObject({
      ghosts: 0,
      rowGhosts: 1,
    });
    expect(pageOf(null, items.slice(0, 2), 4).rowGhosts).toBe(0);
  });

  it("leaves rows to the page ghosts when there are several pages", () => {
    expect(pageOf("2", items, 4).rowGhosts).toBe(0);
  });
});
