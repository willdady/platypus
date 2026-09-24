import { describe, it, expect, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CollapsibleSection } from "./collapsible-section";

const KEY = "section:test:open";

const renderSection = () =>
  render(
    <CollapsibleSection title="Skills" storageKey={KEY}>
      <p>Section body</p>
    </CollapsibleSection>,
  );

afterEach(() => {
  localStorage.clear();
});

describe("CollapsibleSection", () => {
  it("starts closed when it has never been toggled", () => {
    renderSection();

    expect(screen.queryByText("Section body")).toBeNull();
  });

  // Read during render, not in an effect: a section restored open paints open
  // on its first frame rather than closed and then animating open.
  it("opens on its first render when it was last left open", () => {
    localStorage.setItem(KEY, "true");
    renderSection();

    expect(screen.getByText("Section body")).toBeInTheDocument();
  });

  it("stays closed when it was last left closed", () => {
    localStorage.setItem(KEY, "false");
    renderSection();

    expect(screen.queryByText("Section body")).toBeNull();
  });

  it("persists a toggle", () => {
    renderSection();

    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));

    expect(screen.getByText("Section body")).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("true");
  });
});
