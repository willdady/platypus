import { describe, it, expect } from "vitest";
import { backendPath } from "./server-read";

describe("backendPath", () => {
  it("encodes each interpolated id so it stays one path segment", () => {
    expect(backendPath`/organizations/${"a/b?c"}/workspaces/${"x#y"}`).toBe(
      "/organizations/a%2Fb%3Fc/workspaces/x%23y",
    );
  });

  it("leaves the literal parts of the path alone", () => {
    expect(backendPath`/organizations/${"o1"}/tools`).toBe(
      "/organizations/o1/tools",
    );
  });
});
