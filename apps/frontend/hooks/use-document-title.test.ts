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

  it("puts the route's title back when the entity loses its name", () => {
    const { rerender } = renderHook(
      ({ name }: { name?: string }) => useDocumentTitle(name, "Research"),
      { initialProps: { name: "Trip planning" as string | undefined } },
    );

    rerender({ name: undefined });

    expect(document.title).toBe("Chat | Research | Platypus");
  });

  it("puts the route's title back on unmount", () => {
    const { unmount } = renderHook(() =>
      useDocumentTitle("Trip planning", "Research"),
    );

    unmount();

    expect(document.title).toBe("Chat | Research | Platypus");
  });

  it("leaves a title the next route set on unmount", () => {
    const { unmount } = renderHook(() =>
      useDocumentTitle("Trip planning", "Research"),
    );
    document.title = "Agents | Research | Platypus";

    unmount();

    expect(document.title).toBe("Agents | Research | Platypus");
  });
});
