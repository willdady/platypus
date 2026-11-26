import { describe, it, expect } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import {
  humanizeToolType,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "./tool";

describe("humanizeToolType", () => {
  it.each([
    ["tool-getBoardState", "Get board state"],
    ["tool-web_search", "Web search"],
    ["tool-read_url", "Read url"],
    ["tool-fsRead", "Fs read"],
    ["tool-github__create_issue", "Github create issue"],
    ["web_search", "Web search"],
  ])("renders %s as %s", (type, expected) => {
    expect(humanizeToolType(type)).toBe(expected);
  });
});

describe("Tool disclosure", () => {
  const renderTool = (
    props: Partial<ComponentProps<typeof ToolHeader>> = {},
    children: ReactNode = <div>Body</div>,
  ) =>
    render(
      <Tool data-testid="tool-row">
        <ToolHeader type="tool-getCard" state="output-available" {...props} />
        <ToolContent>{children}</ToolContent>
      </Tool>,
    );

  it("is collapsed until clicked, then opens", () => {
    renderTool();
    const trigger = screen.getByRole("button", { name: /Get card/ });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Body")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Body")).toBeInTheDocument();
  });

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
    renderTool();
    expect(screen.getByTestId("tool-row").className).not.toMatch(/\bborder\b/);
  });

  it("truncates a long name and keeps the full name on the element", () => {
    const name = "cloudflare_agent_sandbox__execute_javascript_in_worker";
    renderTool({ title: name });

    const label = screen.getByText(name);
    expect(label).toHaveClass("truncate");
    expect(label).toHaveAttribute("title", name);
    expect(screen.getByRole("button")).toHaveClass("min-w-0");
  });

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
    const outerChevron = within(outer).getByTestId("tool-chevron");
    const innerChevron = within(inner).getByTestId("tool-chevron");
    expect(inner).toHaveAttribute("aria-expanded", "false");
    expect(outerChevron).toHaveClass("rotate-180");
    expect(innerChevron).not.toHaveClass("rotate-180");

    fireEvent.click(inner);

    expect(inner).toHaveAttribute("aria-expanded", "true");
    expect(within(inner).getByTestId("tool-chevron")).toHaveClass("rotate-180");
    expect(screen.getByText("Inner body")).toBeInTheDocument();
  });
});

describe("Tool parameter and result panels", () => {
  const longUrl = `https://example.com/${"x".repeat(400)}`;

  it("pretty-prints the input as scrollable JSON", () => {
    render(<ToolInput input={{ url: longUrl }} />);
    const panel = screen.getByRole("group", { name: "Parameters" });
    const pre = within(panel).getByText(/"url"/);

    expect(pre).toHaveTextContent(`"url": "${longUrl}"`);
    expect(pre).toHaveClass("overflow-auto");
    expect(panel).not.toHaveClass("overflow-hidden");
  });

  it("pretty-prints an object result as scrollable JSON", () => {
    render(<ToolOutput output={{ url: longUrl }} errorText={undefined} />);
    const panel = screen.getByRole("group", { name: "Result" });
    const pre = within(panel).getByText(/"url"/);

    expect(pre).toHaveTextContent(`"url": "${longUrl}"`);
    expect(pre).toHaveClass("overflow-auto");
  });

  it("draws Parameters and Result in the same colour", () => {
    render(
      <Tool defaultOpen>
        <ToolHeader type="tool-getCard" state="output-available" />
        <ToolContent>
          <ToolInput input={{ id: "card-1" }} />
          <ToolOutput output={{ id: "card-1" }} errorText={undefined} />
        </ToolContent>
      </Tool>,
    );

    const parameters = within(
      screen.getByRole("group", { name: "Parameters" }),
    ).getByText(/"id"/);
    const result = within(
      screen.getByRole("group", { name: "Result" }),
    ).getByText(/"id"/);

    expect(parameters).toHaveClass("text-foreground");
    expect(result).toHaveClass("text-foreground");
  });
});
