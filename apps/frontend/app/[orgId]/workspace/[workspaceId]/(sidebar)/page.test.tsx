import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  authMock,
  mockScopedSWR,
  mutate,
  navigationMock,
  renderList,
  resetListHarness,
  swrMock,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => ({
  ...navigationMock,
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));
vi.mock("swr", () => swrMock);

import Workspace from "./page";

const WORKSPACE = { id: "ws1", organizationId: "org1", name: "Research" };

const workspaceRead = { "/workspaces/ws1": { data: WORKSPACE } };

beforeEach(() => {
  resetListHarness();
  localStorage.clear();
});

describe("Workspace home", () => {
  it("shows the workspace skeleton while providers are loading", async () => {
    mockScopedSWR({
      "/providers": { isLoading: true },
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    expect(
      screen.getByRole("status", { name: "Loading workspace" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No providers configured"),
    ).not.toBeInTheDocument();
  });

  it("offers to add a provider when the workspace has none", async () => {
    mockScopedSWR({ "/providers": [], ...workspaceRead });
    await renderList(<Workspace />);

    expect(screen.getByText("No providers configured")).toBeInTheDocument();
  });

  it("shows a failed providers read as an error with a retry, not as no providers", async () => {
    mockScopedSWR({
      "/providers": { error: { status: 500, message: "Server error" } },
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    expect(
      screen.getByText("Failed to load providers. Server error"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No providers configured"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });

  it("shows pinned agents in their own group above the rest", async () => {
    const agent = (id: string, name: string, isPinned: boolean) => ({
      id,
      name,
      description: "desc",
      scope: "workspace",
      isPinned,
      toolSetIds: [],
      skillIds: [],
      subAgentIds: [],
    });
    mockScopedSWR({
      "/agents": [agent("a1", "Triage", false), agent("a2", "Writer", true)],
      "/providers": [{ id: "p1", name: "OpenAI" }],
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    const pinned = screen.getByRole("list", { name: "Pinned agents" });
    const rest = screen.getByRole("list", { name: "Agents" });
    expect(within(pinned).getByText("Writer")).toBeInTheDocument();
    expect(within(pinned).queryByText("Triage")).not.toBeInTheDocument();
    expect(within(rest).getByText("Triage")).toBeInTheDocument();
    expect(within(rest).queryByText("Writer")).not.toBeInTheDocument();
    expect(
      pinned.compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no Pinned group when no agent is pinned", async () => {
    mockScopedSWR({
      "/agents": [
        {
          id: "a1",
          name: "Triage",
          description: "desc",
          isPinned: false,
          toolSetIds: [],
          skillIds: [],
          subAgentIds: [],
        },
      ],
      "/providers": [{ id: "p1", name: "OpenAI" }],
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Pinned" }),
    ).not.toBeInTheDocument();
  });

  it("leaves fired One-offs out of the count, whether or not the list shows them", async () => {
    const activeTrigger = {
      id: "t1",
      name: "Nightly job",
      type: "cron",
      enabled: true,
      agentId: "a1",
      config: { cronExpression: "0 0 * * *", timezone: "UTC" },
    };
    const firedOneOff = {
      ...activeTrigger,
      id: "t2",
      name: "Launch reminder",
      enabled: false,
      config: { ...activeTrigger.config, isOneOff: true },
      firedAt: "2026-02-01T08:00:00.000Z",
    };
    mockScopedSWR({
      "/providers": [{ id: "p1", name: "OpenAI" }],
      "/triggers": [activeTrigger, firedOneOff],
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    const triggersCard = screen.getByRole("group", { name: "Triggers" });
    expect(within(triggersCard).getByText("1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Triggers/ }));
    expect(screen.queryByText("Launch reminder")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Show fired" }));
    expect(screen.getByText("Launch reminder")).toBeInTheDocument();
    expect(within(triggersCard).getByText("1")).toBeInTheDocument();
  });

  it("keeps the Boards count on its stat card but no Boards section", async () => {
    mockScopedSWR({
      "/boards": [
        { id: "b1", name: "Sprint planning" },
        { id: "b2", name: "Backlog" },
      ],
      "/providers": [{ id: "p1", name: "OpenAI" }],
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    const boardsCard = screen.getByRole("group", { name: "Boards" });
    expect(within(boardsCard).getByText("2")).toBeInTheDocument();

    expect(
      screen.queryByRole("heading", { name: "Boards" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Create board" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("searchbox", { name: "Search boards" }),
    ).not.toBeInTheDocument();
  });

  it("counts every Artifact from the list envelope, not the one row it fetches", async () => {
    mockScopedSWR({
      "/artifacts": { data: { results: [{ id: "a1" }], totalCount: 7 } },
      "/providers": [{ id: "p1", name: "OpenAI" }],
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    const artifactsCard = screen.getByRole("group", { name: "Artifacts" });
    expect(within(artifactsCard).getByText("7")).toBeInTheDocument();
  });

  it("leaves the Boards section out of the loading skeleton", async () => {
    localStorage.setItem("section:boards:open", "true");
    mockScopedSWR({
      "/providers": { isLoading: true },
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    const region = screen.getByRole("status", { name: "Loading workspace" });
    expect(within(region).getAllByRole("separator")).toHaveLength(2);
  });

  it("shows a failed count as an error, not as 0", async () => {
    mockScopedSWR({
      "/skills": { error: { status: 500, message: "Server error" } },
      "/providers": [{ id: "p1", name: "OpenAI" }],
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    expect(screen.getAllByLabelText("Couldn't load skills")).not.toHaveLength(
      0,
    );
  });

  it("renders the page while a count is still loading", async () => {
    mockScopedSWR({
      "/boards": { isLoading: true },
      "/providers": [{ id: "p1", name: "OpenAI" }],
      ...workspaceRead,
    });
    await renderList(<Workspace />);

    expect(
      screen.getByRole("heading", { name: "Research" }),
    ).toBeInTheDocument();
    expect(screen.getAllByLabelText("Loading Boards")).not.toHaveLength(0);
  });

  it("says the workspace is gone, with the way back, when the read returns none", async () => {
    mockScopedSWR({ "/workspaces/ws1": { data: undefined } });
    await renderList(<Workspace />);

    expect(screen.getByText("Workspace not found")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to Organization" }),
    ).toHaveAttribute("href", "/org1");
  });

  it("shows a failed workspace read as an error with a retry, not as not found", async () => {
    mockScopedSWR({
      "/workspaces/ws1": { error: { status: 500, message: "Server error" } },
    });
    await renderList(<Workspace />);

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByText("Workspace not found")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });
});
