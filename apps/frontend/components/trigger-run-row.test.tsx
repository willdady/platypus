import { describe, it, expect } from "vitest";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import type { TriggerRunWithTrigger } from "@platypus/schemas";
import {
  TriggerRunRow,
  triggerRunDetailHref,
  RUN_WARNINGS_LABEL,
} from "./trigger-run-row";
import { openDropdownMenu } from "@/test/test-utils";

const run = (
  over: Partial<TriggerRunWithTrigger> = {},
): TriggerRunWithTrigger => ({
  id: "run-1",
  triggerId: "trigger-1",
  triggerName: "Nightly digest",
  status: "success",
  eventType: null,
  eventData: null,
  startedAt: new Date("2026-01-01T09:00:00Z"),
  completedAt: new Date("2026-01-01T09:00:10Z"),
  errorMessage: null,
  stats: null,
  unloadedToolSets: [],
  failedToolCalls: 0,
  createdAt: new Date("2026-01-01T09:00:00Z"),
  ...over,
});

describe("TriggerRunRow", () => {
  it("makes the whole row a link to the run's own page", () => {
    render(<TriggerRunRow run={run()} orgId="org-1" workspaceId="ws-1" />);

    const row = screen.getByText("Nightly digest").closest("a");
    expect(row).toHaveAttribute(
      "href",
      "/org-1/workspace/ws-1/trigger-runs/run-1",
    );
    expect(triggerRunDetailHref("org-1", "ws-1", "run-1")).toBe(
      "/org-1/workspace/ws-1/trigger-runs/run-1",
    );
  });

  it("names the Trigger as plain text, never a link of its own", () => {
    render(
      <TriggerRunRow
        run={run()}
        orgId="org-1"
        workspaceId="ws-1"
        linkToDetail={false}
      />,
    );

    expect(screen.getByText("Nightly digest").closest("a")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("offers no page for a suppressed firing, which never ran", () => {
    render(
      <TriggerRunRow
        run={run({ status: "suppressed" })}
        orgId="org-1"
        workspaceId="ws-1"
      />,
    );

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps no standalone icon actions on the row", () => {
    render(<TriggerRunRow run={run()} orgId="org-1" workspaceId="ws-1" />);

    expect(screen.queryByLabelText("View run")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Copy run id")).not.toBeInTheDocument();
  });

  describe("the row's actions menu", () => {
    const menuItems = () =>
      screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());

    it("offers Edit trigger then Copy run id in the list", () => {
      render(<TriggerRunRow run={run()} orgId="org-1" workspaceId="ws-1" />);
      openDropdownMenu();

      expect(menuItems()).toEqual(["Edit trigger", "Copy run id"]);
      expect(
        screen.getByRole("menuitem", { name: "Edit trigger" }),
      ).toHaveAttribute("href", "/org-1/workspace/ws-1/triggers/trigger-1");
    });

    it("is named for the run's Trigger", () => {
      render(<TriggerRunRow run={run()} orgId="org-1" workspaceId="ws-1" />);

      expect(
        screen.getByRole("button", { name: "Actions for Nightly digest run" }),
      ).toBeInTheDocument();
    });

    it("offers the same items on a suppressed firing's row", () => {
      render(
        <TriggerRunRow
          run={run({ status: "suppressed" })}
          orgId="org-1"
          workspaceId="ws-1"
        />,
      );
      openDropdownMenu();

      expect(menuItems()).toEqual(["Edit trigger", "Copy run id"]);
    });

    it("adds View trigger's runs on the run's own page", () => {
      render(
        <TriggerRunRow
          run={run()}
          orgId="org-1"
          workspaceId="ws-1"
          linkToDetail={false}
        />,
      );
      openDropdownMenu();

      expect(menuItems()).toEqual([
        "Edit trigger",
        "View trigger's runs",
        "Copy run id",
      ]);
      expect(
        screen.getByRole("menuitem", { name: "View trigger's runs" }),
      ).toHaveAttribute(
        "href",
        "/org-1/workspace/ws-1/trigger-runs?triggerId=trigger-1",
      );
    });

    it("does not open the run when the menu is opened or used", () => {
      render(<TriggerRunRow run={run()} orgId="org-1" workspaceId="ws-1" />);
      const trigger = screen.getByRole("button", {
        name: "Actions for Nightly digest run",
      });

      openDropdownMenu();
      const copy = screen.getByRole("menuitem", { name: "Copy run id" });
      const choosing = createEvent.click(copy);
      fireEvent(copy, choosing);
      expect(choosing.defaultPrevented).toBe(true);

      const opening = createEvent.click(trigger);
      fireEvent(trigger, opening);
      expect(opening.defaultPrevented).toBe(true);
    });
  });

  // #1410: no badge column squeezing the text on a phone.
  it("shows the status under the Trigger name, before the start time, in the same column", () => {
    render(<TriggerRunRow run={run()} orgId="org-1" workspaceId="ws-1" />);

    const name = screen.getByText("Nightly digest");
    const badge = screen.getByText("Success");
    const relative = screen.getByText(/ago$/);
    const column = name.parentElement!;
    expect(column).toContainElement(badge);
    expect(column).toContainElement(relative);
    expect(name.compareDocumentPosition(badge)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(badge.compareDocumentPosition(relative)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  // #647: someone stopped it, nothing faulted — so it is not drawn as a failure.
  it("labels a cancelled run Cancelled, without an error", () => {
    render(
      <TriggerRunRow
        run={run({ status: "cancelled", errorMessage: null })}
        orgId="org-1"
        workspaceId="ws-1"
      />,
    );

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  describe("tools the run went without (#1184)", () => {
    it("names each Tool set that loaded no tools, and why, on a successful run", () => {
      render(
        <TriggerRunRow
          run={run({
            unloadedToolSets: [
              { toolSetId: "mcp-1", name: "Jira", reason: "unreachable" },
              { toolSetId: "gone", name: null, reason: "not_found" },
            ],
          })}
          orgId="org-1"
          workspaceId="ws-1"
        />,
      );

      expect(screen.getByText("Success")).toBeInTheDocument();
      expect(
        screen.getByText("'Jira' loaded no tools: unreachable"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("'gone' loaded no tools: not found"),
      ).toBeInTheDocument();
    });

    it("counts the tool calls that failed", () => {
      render(
        <TriggerRunRow
          run={run({ failedToolCalls: 2 })}
          orgId="org-1"
          workspaceId="ws-1"
        />,
      );

      expect(screen.getByText("2 tool calls failed")).toBeInTheDocument();
    });

    it("says one failed tool call in the singular", () => {
      render(
        <TriggerRunRow
          run={run({ failedToolCalls: 1 })}
          orgId="org-1"
          workspaceId="ws-1"
        />,
      );

      expect(screen.getByText("1 tool call failed")).toBeInTheDocument();
    });

    it("shows no warning for a clean run", () => {
      render(<TriggerRunRow run={run()} orgId="org-1" workspaceId="ws-1" />);

      expect(
        screen.queryByLabelText(RUN_WARNINGS_LABEL),
      ).not.toBeInTheDocument();
    });
  });
});
