import { describe, it, expect } from "vitest";
import { buildResourceUrl } from "./resource-url.ts";

describe("buildResourceUrl", () => {
  it("should build a correct resource URL", () => {
    expect(
      buildResourceUrl("http://localhost:3000", "org-1", "ws-1", "chat/c1"),
    ).toBe("http://localhost:3000/org-1/workspace/ws-1/chat/c1");
  });

  it("should strip trailing slashes from frontendUrl", () => {
    expect(
      buildResourceUrl("http://localhost:3000///", "org-1", "ws-1", "boards"),
    ).toBe("http://localhost:3000/org-1/workspace/ws-1/boards");
  });

  it("should handle resource paths with nested segments", () => {
    expect(
      buildResourceUrl(
        "http://localhost:3000",
        "org-1",
        "ws-1",
        "boards/b1/cards/c1",
      ),
    ).toBe("http://localhost:3000/org-1/workspace/ws-1/boards/b1/cards/c1");
  });
});
