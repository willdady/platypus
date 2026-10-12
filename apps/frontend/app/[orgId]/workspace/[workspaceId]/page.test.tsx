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
  toastMock,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => ({
  ...navigationMock,
  useParams: () => ({ orgId: "org1", workspaceId: "ws1" }),
}));
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import Workspace from "./page";

const WORKSPACE = { id: "ws1", organizationId: "org1", name: "Research" };

// Registered after the Workspace's own lists: every one of their URLs also
// contains the Workspace's, and the harness matches in insertion order.
const workspaceRead = { "/workspaces/ws1": { data: WORKSPACE } };

beforeEach(() => resetListHarness());

describe("Workspace home", () => {
  it("offers to add a provider when the workspace has none", () => {
    mockScopedSWR({ "/providers": [], ...workspaceRead });
    renderList(<Workspace />);

    expect(screen.getByText("No providers configured")).toBeInTheDocument();
  });

  it("shows a failed providers read as an error with a retry, not as no providers", () => {
    mockScopedSWR({
      "/providers": { error: { status: 500, message: "Server error" } },
      ...workspaceRead,
    });
    renderList(<Workspace />);

    expect(
      screen.getByText("Failed to load providers. Server error"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No providers configured")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });

  it("shows pinned agents in their own group above the rest", () => {
    const agent = (id: string, name: string, isPinned: boolean) => ({
      id,
      name,
      description: "desc",
      scope: "workspace",
      isPinned,
    });
    mockScopedSWR({
      "/agents": [agent("a1", "Triage", false), agent("a2", "Writer", true)],
      "/providers": [{ id: "p1", name: "OpenAI" }],
      ...workspaceRead,
    });
    renderList(<Workspace />);

    const pinned = screen.getByRole("list", { name: "Pinned agents" });
    const rest = screen.getByRole("list", { name: "Agents" });
    expect(within(pinned).getByText("Writer")).toBeInTheDocument();
    expect(within(pinned).queryByText("Triage")).toBeNull();
    expect(within(rest).getByText("Triage")).toBeInTheDocument();
    expect(within(rest).queryByText("Writer")).toBeNull();
    expect(
      pinned.compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows no Pinned group when no agent is pinned", () => {
    mockScopedSWR({
      "/agents": [
        { id: "a1", name: "Triage", description: "desc", isPinned: false },
      ],
      "/providers": [{ id: "p1", name: "OpenAI" }],
      ...workspaceRead,
    });
    renderList(<Workspace />);

    expect(screen.getByText("Triage")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pinned" })).toBeNull();
  });

  it("shows a failed workspace read as an error with a retry, not as not found", () => {
    mockScopedSWR({
      "/workspaces/ws1": { error: { status: 500, message: "Server error" } },
    });
    renderList(<Workspace />);

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByText("Workspace not found")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });
});
