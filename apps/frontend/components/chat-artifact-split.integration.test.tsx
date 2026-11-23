import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { ChatArtifactSplit } from "./chat-artifact-split";
import { layOutRow, stubWideViewport } from "@/test/panel-split-harness";

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
});
