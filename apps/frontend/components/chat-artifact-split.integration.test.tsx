import { describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import { ChatArtifactSplit } from "./chat-artifact-split";
import {
  captureRowResize,
  layOutRow,
  stubWideViewport,
} from "@/test/panel-split-harness";

/** A panel whose state is only local to it, to catch a remount. */
function PickedVersion() {
  const [version, setVersion] = useState(1);
  return (
    <button type="button" onClick={() => setVersion((v) => v + 1)}>
      Version {version}
    </button>
  );
}

beforeEach(() => {
  stubWideViewport(true);
  layOutRow(1440);
});

describe("the split's divider", () => {
  it("renders a focusable separator carrying its position", () => {
    render(
      <ChatArtifactSplit panel={<div>Artifact</div>} fullScreen={false}>
        <div>Chat</div>
      </ChatArtifactSplit>,
    );

    const divider = screen.getByRole("separator");
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    expect(divider).toHaveAttribute("tabindex", "0");
    expect(divider).toHaveAttribute("aria-valuenow");
    expect(divider).toHaveAttribute("aria-valuemin");
    expect(divider).toHaveAttribute("aria-valuemax");
    expect(divider).toHaveAttribute("aria-label", "Resize the Artifact panel");

    divider.focus();
    expect(divider).toHaveFocus();
  });

  it("moves with the arrow keys and resets on a double-click", () => {
    render(
      <ChatArtifactSplit panel={<div>Artifact</div>} fullScreen={false}>
        <div>Chat</div>
      </ChatArtifactSplit>,
    );

    const divider = screen.getByRole("separator");
    const defaultPosition = divider.getAttribute("aria-valuenow") ?? "";

    divider.focus();
    fireEvent.keyDown(divider, { key: "ArrowLeft" });

    // `toHaveValue` reads form controls; a separator carries `aria-valuenow`.
    // eslint-disable-next-line jest-dom/prefer-to-have-value
    expect(divider).not.toHaveAttribute("aria-valuenow", defaultPosition);

    fireEvent.doubleClick(divider);

    // eslint-disable-next-line jest-dom/prefer-to-have-value
    expect(divider).toHaveAttribute("aria-valuenow", defaultPosition);
  });
});

describe("the split's view of the panel", () => {
  it("keeps the panel's state when the row drops below the split minimum", () => {
    const resizeRow = captureRowResize();
    render(
      <ChatArtifactSplit panel={<PickedVersion />} fullScreen={false}>
        <div>Chat</div>
      </ChatArtifactSplit>,
    );

    const picked = screen.getByRole("button", { name: "Version 1" });
    fireEvent.click(picked);
    expect(picked).toHaveTextContent("Version 2");
    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-presentation",
      "split",
    );

    layOutRow(700);
    act(() => resizeRow());

    expect(screen.getByRole("complementary")).toHaveAttribute(
      "data-presentation",
      "overlay",
    );
    // Same node, still reading its picked version: the panel never left the
    // tree, it only changed presentation.
    expect(screen.getByRole("button", { name: "Version 2" })).toBe(picked);
  });
});
