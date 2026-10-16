import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDocumentTitle } from "./use-document-title";

beforeEach(() => {
  document.title = "Chat | Research | Platypus";
});

describe("useDocumentTitle", () => {
  it("names the entity, its Workspace and the app in the tab", () => {
    renderHook(() => useDocumentTitle("Trip planning", "Research"));

    expect(document.title).toBe("Trip planning | Research | Platypus");
  });

  it("follows the entity when it is renamed", () => {
    const { rerender } = renderHook(
      ({ name }) => useDocumentTitle(name, "Research"),
      { initialProps: { name: "Trip planning" } },
    );

    rerender({ name: "Trip to Kyoto" });

    expect(document.title).toBe("Trip to Kyoto | Research | Platypus");
  });

  it("leaves the route's title alone until the entity has a name", () => {
    renderHook(() => useDocumentTitle(undefined, "Research"));

    expect(document.title).toBe("Chat | Research | Platypus");
  });

  it("names only the entity and the app when the Workspace is unknown", () => {
    renderHook(() => useDocumentTitle("Trip planning", undefined));

    expect(document.title).toBe("Trip planning | Platypus");
  });
});
