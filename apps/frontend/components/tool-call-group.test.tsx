import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  advanceVerb,
  partitionParts,
  ToolCallGroup,
  TOOL_CALL_VERBS,
} from "./tool-call-group";

function isTool(part: { type: string }): part is { type: string } {
  return part.type.startsWith("tool-");
}

function shape(parts: { type: string }[]) {
  return partitionParts(parts, isTool).map((segment) =>
    segment.kind === "group"
      ? segment.entries.map((entry) => entry.index)
      : segment.index,
  );
}

describe("partitionParts", () => {
  it("groups adjacent groupable calls and keeps their indices", () => {
    expect(
      shape([{ type: "text" }, { type: "tool-a" }, { type: "tool-b" }]),
    ).toEqual([0, [1, 2]]);
  });

  it("groups a single call on its own", () => {
    expect(shape([{ type: "tool-a" }])).toEqual([[0]]);
  });

  it("ends a group at any other part, never merging across it", () => {
    expect(
      shape([
        { type: "tool-a" },
        { type: "reasoning" },
        { type: "tool-b" },
        { type: "delegate" },
        { type: "tool-c" },
      ]),
    ).toEqual([[0], 1, [2], 3, [4]]);
  });

  // A step boundary draws nothing, so a call in the next step sits right
  // under the previous one on screen.
  it("does not end a group at a step boundary", () => {
    expect(
      shape([
        { type: "step-start" },
        { type: "tool-a" },
        { type: "step-start" },
        { type: "tool-b" },
      ]),
    ).toEqual([0, [1, 3]]);
  });

  it("drops a hidden part without ending the group around it", () => {
    const parts = [{ type: "tool-a" }, { type: "hidden" }, { type: "tool-b" }];
    expect(
      partitionParts(parts, isTool, (part) => part.type === "hidden").map(
        (segment) =>
          segment.kind === "group"
            ? segment.entries.map((entry) => entry.index)
            : segment.index,
      ),
    ).toEqual([[0, 2]]);
  });
});

describe("advanceVerb", () => {
  const start = { verb: TOOL_CALL_VERBS[0], count: 1, changedAt: 0 };

  it("keeps the verb when no call has joined", () => {
    expect(advanceVerb(start, 1, 5000, () => 0.5)).toBe(start);
  });

  it("absorbs a join inside the 2s hold", () => {
    const next = advanceVerb(start, 2, 1999, () => 0.5);
    expect(next.verb).toBe(start.verb);
    expect(next.count).toBe(2);
    expect(next.changedAt).toBe(0);
  });

  it("re-picks on a join after the hold, never the same verb twice", () => {
    // `random` of 0 would land on the current verb, the first in the list.
    const next = advanceVerb(start, 2, 2000, () => 0);
    expect(next.verb).not.toBe(start.verb);
    expect(next).toMatchObject({ count: 2, changedAt: 2000 });
  });
});

describe("ToolCallGroup", () => {
  const names = [
    "Web search",
    "Read file",
    "Web search",
    "Shell exec",
    "Fs list",
  ];

  function renderGroup(
    props: Partial<React.ComponentProps<typeof ToolCallGroup>>,
  ) {
    return render(
      <ToolCallGroup names={names} errored={false} active={false} {...props}>
        <p>child call</p>
      </ToolCallGroup>,
    );
  }

  it("summarises a settled group by its distinct names, in order", () => {
    renderGroup({});
    const header = screen.getByRole("button", {
      name: "5 tool calls: Web search, Read file, Shell exec, Fs list",
    });
    expect(header).toHaveTextContent("Web search, Read file+2 more");
  });

  it("starts collapsed and opens only on the reader's click", () => {
    renderGroup({});
    const header = screen.getByRole("button");
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("child call")).not.toBeVisible();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("child call")).toBeVisible();
  });

  it("shows only a verb while active, with the same accessible name", () => {
    renderGroup({ active: true, errored: true });
    const header = screen.getByRole("button", {
      name: "5 tool calls: Web search, Read file, Shell exec, Fs list",
    });
    expect(header).not.toHaveTextContent("Web search");
    expect(header).not.toHaveTextContent("Error");
    expect(
      TOOL_CALL_VERBS.some((verb) => header.textContent?.includes(verb)),
    ).toBe(true);
  });

  it("settles once and never goes back to active", () => {
    const { rerender } = renderGroup({ active: true });
    const group = (active: boolean) => (
      <ToolCallGroup names={names} errored={false} active={active}>
        <p>child call</p>
      </ToolCallGroup>
    );
    rerender(group(false));
    expect(screen.getByRole("button")).toHaveTextContent("Web search");
    rerender(group(true));
    expect(screen.getByRole("button")).toHaveTextContent("Web search");
  });

  it("badges a settled group when any call errored", () => {
    renderGroup({ errored: true });
    expect(
      screen.getByRole("button", { name: /with errors/ }),
    ).toHaveTextContent("Error");
  });
});
