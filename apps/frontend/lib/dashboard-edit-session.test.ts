// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { RglLayoutItem, WidgetType } from "@platypus/schemas";
import {
  cancelPlan,
  commitPlan,
  effectiveLayouts,
  recordDeletion,
  savedDeletions,
  stageAddition,
  stageDeletion,
  stageMove,
  startEditSession,
} from "./dashboard-edit-session";

const item = (i: string, y = 0, h = 5): RglLayoutItem => ({
  i,
  x: 0,
  y,
  w: 3,
  h,
});

const types = (entries: Record<string, WidgetType>) =>
  new Map(Object.entries(entries));

const server = {
  desktopLayout: [item("a", 0), item("b", 5)],
  mobileLayout: [] as RglLayoutItem[],
};

describe("startEditSession", () => {
  it("copies both server layouts", () => {
    const mobileLayout = [{ i: "a", x: 0, y: 0, w: 2, h: 5 }];
    const session = startEditSession({ ...server, mobileLayout });
    expect(session.desktopLayout).toEqual(server.desktopLayout);
    expect(session.mobileLayout).toEqual(mobileLayout);
    expect(commitPlan(session).deletions).toEqual([]);
    expect(cancelPlan(session)).toEqual([]);
  });

  it("falls back to a registry-aware mobile layout when mobile is empty", () => {
    const session = startEditSession(server);
    const { mobile } = effectiveLayouts(
      session,
      server,
      types({ a: "weather", b: "text" }),
    );
    const weather = mobile.find((m) => m.i === "a")!;
    expect(weather.h).toBeGreaterThanOrEqual(8);
    expect(weather).toMatchObject({ x: 0, y: 0, w: 2 });
    // Stacked below the weather tile, not at a fixed stride.
    expect(mobile.find((m) => m.i === "b")).toMatchObject({ y: weather.h });
  });
});

describe("stageAddition", () => {
  it("places the widget at the bottom of each layout using defaultSize", () => {
    const session = stageAddition(
      startEditSession({
        ...server,
        mobileLayout: [{ i: "a", x: 0, y: 0, w: 2, h: 4 }],
      }),
      { id: "c", type: "line-chart" },
      types({ a: "text", b: "text" }),
    );
    expect(session.desktopLayout.at(-1)).toEqual({
      i: "c",
      x: 0,
      y: 10,
      w: 6,
      h: 8,
    });
    expect(session.mobileLayout.at(-1)).toEqual({
      i: "c",
      x: 0,
      y: 4,
      w: 2,
      h: 8,
    });
    expect(cancelPlan(session)).toEqual(["c"]);
  });

  it("keeps every other widget in a mobile layout that was the fallback", () => {
    const widgetTypes = types({ a: "weather", b: "text" });
    const before = effectiveLayouts(
      startEditSession(server),
      server,
      widgetTypes,
    ).mobile;
    const session = stageAddition(
      startEditSession(server),
      { id: "c", type: "text" },
      widgetTypes,
    );
    expect(session.mobileLayout.slice(0, 2)).toEqual(
      before.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })),
    );
    // Add-placement agrees with the fallback's height for the same type.
    expect(session.mobileLayout.at(-1)).toMatchObject({
      i: "c",
      y: before[0].h + before[1].h,
      h: before[1].h,
    });
  });
});

describe("stageDeletion", () => {
  it("removes the item from both layouts and stages the DELETE", () => {
    const session = stageDeletion(
      startEditSession({ ...server, mobileLayout: [item("a")] }),
      "a",
    );
    expect(session.desktopLayout.map((m) => m.i)).toEqual(["b"]);
    expect(session.mobileLayout).toEqual([]);
    expect(commitPlan(session).deletions).toEqual(["a"]);
  });

  it("deletes a staged addition once, whichever plan runs", () => {
    const added = stageAddition(
      startEditSession(server),
      { id: "c", type: "text" },
      new Map(),
    );
    const session = stageDeletion(added, "c");
    expect(commitPlan(session).deletions).toEqual(["c"]);
    expect(cancelPlan(session)).toEqual(["c"]);

    const afterSave = recordDeletion(session, "c", "success");
    expect(commitPlan(afterSave).deletions).toEqual([]);
    expect(cancelPlan(afterSave)).toEqual([]);
  });
});

describe("commitPlan", () => {
  it("carries the staged layouts for the PUT", () => {
    const session = stageMove(startEditSession(server), "mobile", [
      item("b"),
      item("a", 5),
    ]);
    expect(commitPlan(session).layout).toEqual({
      desktopLayout: server.desktopLayout,
      mobileLayout: [item("b"), item("a", 5)],
    });
  });

  it("re-attempts only the deletions that failed", () => {
    let session = stageDeletion(
      stageDeletion(startEditSession(server), "a"),
      "b",
    );
    expect(commitPlan(session).deletions).toEqual(["a", "b"]);

    session = recordDeletion(session, "a", "success");
    session = recordDeletion(session, "b", "error");
    expect(commitPlan(session).deletions).toEqual(["b"]);

    session = recordDeletion(session, "b", "success");
    expect(commitPlan(session).deletions).toEqual([]);
    expect(commitPlan(session).layout.desktopLayout).toEqual([]);
  });

  it("counts a notFound DELETE as landed", () => {
    const session = recordDeletion(
      stageDeletion(startEditSession(server), "a"),
      "a",
      "notFound",
    );
    expect(commitPlan(session).deletions).toEqual([]);
    expect(savedDeletions(session)).toEqual(["a"]);
  });
});

describe("cancelPlan", () => {
  it("re-attempts only the additions that failed to delete", () => {
    const none = new Map<string, WidgetType>();
    let session = stageAddition(
      stageAddition(startEditSession(server), { id: "x", type: "text" }, none),
      { id: "y", type: "text" },
      none,
    );
    session = recordDeletion(session, "x", "success");
    session = recordDeletion(session, "y", "error");
    expect(cancelPlan(session)).toEqual(["y"]);
    // X is gone from the server, so it leaves the layouts and the Save plan.
    expect(session.desktopLayout.map((m) => m.i)).not.toContain("x");
    expect(commitPlan(session).deletions).toEqual([]);
    // Undoing an addition is not a change the user saved.
    expect(savedDeletions(session)).toEqual([]);
  });
});

describe("effectiveLayouts", () => {
  it("shows the server layouts when not editing", () => {
    const { desktop } = effectiveLayouts(null, server, new Map());
    expect(desktop.map((m) => m.i)).toEqual(["a", "b"]);
  });

  it("stamps minW/minH from the registry, defaulting to 1/3", () => {
    const { desktop, mobile } = effectiveLayouts(
      null,
      server,
      types({ a: "bar-chart", b: "text" }),
    );
    expect(desktop[0]).toMatchObject({ minW: 2, minH: 6 });
    expect(desktop[1]).toMatchObject({ minW: 1, minH: 3 });
    expect(mobile[0]).toMatchObject({ minW: 2, minH: 6 });
  });
});
