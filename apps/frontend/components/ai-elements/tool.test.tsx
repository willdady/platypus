import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { humanizeToolType, Tool, ToolContent, ToolHeader } from "./tool";

// The header label is the only place a tool name is shown as prose, and the names
// reaching it are not all camelCase: provider-native search and the Web-search
// backend tools are snake_case by design (ADR-0014), and most MCP servers namespace
// with underscores too.
describe("humanizeToolType", () => {
  it.each([
    ["tool-getBoardState", "Get board state"],
    ["tool-web_search", "Web search"],
    ["tool-read_url", "Read url"],
    ["tool-fsRead", "Fs read"],
    // MCP servers commonly join a namespace with a double underscore.
    ["tool-github__create_issue", "Github create issue"],
    // The prefix is optional: `dynamic-tool` parts pass a bare tool name.
    ["web_search", "Web search"],
  ])("renders %s as %s", (type, expected) => {
    expect(humanizeToolType(type)).toBe(expected);
  });
});

// Issue #834. A tool call is an execution record drawn as a Thinking-style
// disclosure: collapsed until clicked, never opened or closed on the reader's
// behalf, and safe to nest.
describe("Tool disclosure", () => {
  const renderTool = (
    props: Partial<ComponentProps<typeof ToolHeader>> = {},
    children: ReactNode = <div>Body</div>,
  ) =>
    render(
      <Tool>
        <ToolHeader type="tool-getCard" state="output-available" {...props} />
        <ToolContent>{children}</ToolContent>
      </Tool>,
    );

  it("is collapsed until clicked, then opens", () => {
    renderTool();
    const trigger = screen.getByRole("button", { name: /Get card/ });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Body")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Body")).toBeInTheDocument();
  });

  // Unlike Thinking, a tool that finishes does not open or close itself.
  it("stays collapsed when the call moves from running to completed", () => {
    const { rerender } = render(
      <Tool>
        <ToolHeader type="tool-getCard" state="input-available" />
        <ToolContent>Body</ToolContent>
      </Tool>,
    );
    rerender(
      <Tool>
        <ToolHeader type="tool-getCard" state="output-available" />
        <ToolContent>Body</ToolContent>
      </Tool>,
    );

    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it.each([
    ["input-streaming", "Pending"],
    ["input-available", "Running"],
    ["output-available", "Completed"],
    ["output-error", "Error"],
    ["approval-requested", "Approval Requested"],
    ["approval-responded", "Approval Responded"],
    ["output-denied", "Denied"],
  ] as const)("labels state %s as %s", (state, label) => {
    renderTool({ state });
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("draws no border around the row", () => {
    const { container } = renderTool();
    expect(container.firstElementChild?.className).not.toMatch(/\bborder\b/);
  });

  // Issue #691: MCP names are long and the row is narrow on a phone. The label
  // truncates rather than overflowing, and the whole name stays reachable.
  it("truncates a long name and keeps the full name on the element", () => {
    const name = "cloudflare_agent_sandbox__execute_javascript_in_worker";
    renderTool({ title: name });

    const label = screen.getByText(name);
    expect(label).toHaveClass("truncate");
    expect(label.closest("[title]")).toHaveAttribute("title", name);
    expect(screen.getByRole("button")).toHaveClass("min-w-0");
  });

  // A Sub-Agent's body embeds further disclosures. Each chevron answers only
  // to its own row: opening the outer one leaves the inner closed and unturned.
  it("keeps a nested disclosure's chevron independent of its parent", () => {
    renderTool(
      { title: "Outer" },
      <Tool>
        <ToolHeader
          title="Inner"
          type="tool-getCard"
          state="output-available"
        />
        <ToolContent>Inner body</ToolContent>
      </Tool>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Outer/ }));

    const outer = screen.getByRole("button", { name: /Outer/ });
    const inner = screen.getByRole("button", { name: /Inner/ });
    expect(inner).toHaveAttribute("aria-expanded", "false");
    expect(outer.querySelector(":scope > svg:last-child")).toHaveClass(
      "rotate-180",
    );
    expect(inner.querySelector(":scope > svg:last-child")).not.toHaveClass(
      "rotate-180",
    );

    fireEvent.click(inner);

    expect(inner).toHaveAttribute("aria-expanded", "true");
    expect(inner.querySelector(":scope > svg:last-child")).toHaveClass(
      "rotate-180",
    );
    expect(screen.getByText("Inner body")).toBeInTheDocument();
  });
});
