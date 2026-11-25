import { describe, it, expect } from "vitest";
import { APP_NAME, documentTitle, scopedTitle } from "./page-title";

describe("scopedTitle", () => {
  it("gives each page its own title, then the scope, then the app", () => {
    expect(scopedTitle("Workspace one")).toEqual({
      default: "Workspace one",
      template: `%s | Workspace one | ${APP_NAME}`,
    });
  });

  it("sets no title at all when the scope's name could not be read", () => {
    expect(scopedTitle(undefined)).toBeUndefined();
    expect(scopedTitle(null)).toBeUndefined();
    expect(scopedTitle("")).toBeUndefined();
  });
});

describe("documentTitle", () => {
  it("joins the page's name, its scope and the app", () => {
    expect(documentTitle("Settings", "Workspace one")).toBe(
      `Settings | Workspace one | ${APP_NAME}`,
    );
  });

  it("skips empty parts and always ends with the app", () => {
    expect(documentTitle(null, "Agent", undefined)).toBe(`Agent | ${APP_NAME}`);
    expect(documentTitle()).toBe(APP_NAME);
  });
});
