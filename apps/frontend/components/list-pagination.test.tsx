import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GhostCards, pageBounds, pageOf, serverPage } from "./list-pagination";

const items = ["a", "b", "c", "d", "e"];

describe("pageBounds", () => {
  it("clamps a malformed page to the first", () => {
    expect(pageBounds("nope", 45, 20)).toEqual({ page: 1, pageCount: 3 });
  });

  it("clamps a page past the end to the last", () => {
    expect(pageBounds("9", 45, 20)).toEqual({ page: 3, pageCount: 3 });
  });

  it("reads a numeric page", () => {
    expect(pageBounds(2, 45, 20)).toEqual({ page: 2, pageCount: 3 });
  });

  it("keeps one page for an empty list", () => {
    expect(pageBounds(null, 0, 20)).toEqual({ page: 1, pageCount: 1 });
  });
});

describe("serverPage", () => {
  it("passes the server's rows through with the shared ghost arithmetic", () => {
    expect(serverPage(["d", "e"], 2, 3, 3)).toMatchObject({
      items: ["d", "e"],
      page: 2,
      pageCount: 3,
      ghosts: 1,
      rowGhosts: 0,
    });
  });
});

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

describe("GhostCards", () => {
  it("draws every ghost on wide screens only", () => {
    render(
      <ul>
        <GhostCards page={{ ghosts: 2, rowGhosts: 1 }} />
      </ul>,
    );
    // Ghosts are aria-hidden, so only a `hidden` query finds them.
    const ghosts = screen.getAllByRole("listitem", { hidden: true });
    expect(ghosts).toHaveLength(3);
    for (const ghost of ghosts) {
      expect(ghost).toHaveClass("hidden", "lg:block");
    }
  });
});
