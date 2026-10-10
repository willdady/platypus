import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

import { LoadSkillTool, ReadSkillFileTool } from "./load-skill-tool";

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

type ReadSkillFilePart = ComponentProps<typeof ReadSkillFileTool>["toolPart"];

const readSkillFileCall = (
  overrides: Partial<ReadSkillFilePart> = {},
): ReadSkillFilePart =>
  ({
    type: "tool-readSkillFile",
    toolCallId: "call-2",
    state: "output-available",
    input: { name: "pdf", path: "references/forms.md" },
    output: { path: "references/forms.md", content: "..." },
    ...overrides,
  }) as unknown as ReadSkillFilePart;

describe("ReadSkillFileTool", () => {
  it("names the skill and file on the same one-shot row", () => {
    render(<ReadSkillFileTool toolPart={readSkillFileCall()} />);

    expect(
      screen.getByText("Reading skill file: pdf/references/forms.md"),
    ).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("reports a file it could not read as an error, with its message", () => {
    render(
      <ReadSkillFileTool
        toolPart={readSkillFileCall({
          output: { error: "'logo.png' is a binary file" },
        } as Partial<ReadSkillFilePart>)}
      />,
    );

    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("'logo.png' is a binary file")).toBeInTheDocument();
  });
});
