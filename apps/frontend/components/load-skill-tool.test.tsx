import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

import { LoadSkillTool } from "./load-skill-tool";

type LoadSkillPart = ComponentProps<typeof LoadSkillTool>["toolPart"];

const loadSkillCall = (overrides: Partial<LoadSkillPart> = {}): LoadSkillPart =>
  ({
    type: "tool-loadSkill",
    toolCallId: "call-1",
    state: "output-available",
    input: { name: "release-notes" },
    output: { name: "release-notes", content: "..." },
    ...overrides,
  }) as unknown as LoadSkillPart;

// Issue #834. Loading a Skill is a one-shot status line, not an execution
// record with a body to read, so it shares the disclosure row's look but
// never becomes a disclosure: nothing to click, nothing to expand.
describe("LoadSkillTool", () => {
  it("names the skill and its status without a disclosure to open", () => {
    render(<LoadSkillTool toolPart={loadSkillCall()} />);

    expect(
      screen.getByText("Loading skill: release-notes"),
    ).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports a skill the backend could not load as an error, with its message", () => {
    render(
      <LoadSkillTool
        toolPart={loadSkillCall({
          output: { error: "Skill not found" },
        } as Partial<LoadSkillPart>)}
      />,
    );

    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Skill not found")).toBeInTheDocument();
  });

  it("draws no border, matching the tool rows around it", () => {
    const { container } = render(<LoadSkillTool toolPart={loadSkillCall()} />);

    expect(container.firstElementChild?.className).not.toMatch(/\bborder\b/);
  });
});
