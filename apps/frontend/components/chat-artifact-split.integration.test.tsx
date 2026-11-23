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

describe("the Chat's place in the row", () => {
  /** A Chat whose draft is only local to it, to catch a remount. */
  function Draft() {
    const [draft, setDraft] = useState(0);
    return (
      <button type="button" onClick={() => setDraft((value) => value + 1)}>
        Draft {draft}
      </button>
    );
  }

  it("keeps the Chat's state when the panel opens and closes", () => {
    const chat = <Draft />;
    const { rerender } = render(
      <ChatArtifactSplit panel={null} fullScreen={false}>
        {chat}
      </ChatArtifactSplit>,
    );

    const draft = screen.getByRole("button", { name: "Draft 0" });
    fireEvent.click(draft);
    expect(draft).toHaveTextContent("Draft 1");

    rerender(
      <ChatArtifactSplit panel={<div>Artifact</div>} fullScreen={false}>
        {chat}
      </ChatArtifactSplit>,
    );

    // Same node, still holding its draft: opening the panel puts it inside the
    // split rather than moving it to another position in the tree.
    expect(screen.getByRole("button", { name: "Draft 1" })).toBe(draft);

    rerender(
      <ChatArtifactSplit panel={null} fullScreen={false}>
        {chat}
      </ChatArtifactSplit>,
    );

    expect(screen.getByRole("button", { name: "Draft 1" })).toBe(draft);
  });
});

describe("the row's sizes", () => {
  const panelFlex = (id: string) =>
    parseFloat(screen.getByTestId(id).style.flexGrow);

  /** Lets the primitive's own observers and the component's frame re-apply. */
  async function settle() {
    await act(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
  }

  it("gives the whole row back to the Chat when the panel closes", async () => {
    const { rerender } = render(
      <ChatArtifactSplit panel={<div>Artifact</div>} fullScreen={false}>
        <div>Chat</div>
      </ChatArtifactSplit>,
    );

    expect(panelFlex("chat")).toBeCloseTo(62.22, 1);
    expect(panelFlex("artifact")).toBeCloseTo(37.78, 1);

    rerender(
      <ChatArtifactSplit panel={null} fullScreen={false}>
        <div>Chat</div>
      </ChatArtifactSplit>,
    );
    await settle();

    // The split's old minimum must not clamp the closed panel back open.
    expect(panelFlex("chat")).toBeCloseTo(100, 1);
    expect(panelFlex("artifact")).toBeCloseTo(0, 1);
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
