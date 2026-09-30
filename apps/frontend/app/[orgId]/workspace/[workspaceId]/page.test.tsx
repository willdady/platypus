import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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

// The sections below the stats read and render their own lists, each covered
// by its own suite; this one is about the page's reads.
vi.mock("@/components/agents-list", () => ({
  AgentsList: () => null,
  AgentCardsSkeleton: () => null,
}));
vi.mock("@/components/skills-list", () => ({ SkillsList: () => null }));
vi.mock("@/components/trigger-list", () => ({
  TriggerList: () => null,
  TriggerCardsSkeleton: () => null,
}));
vi.mock("@/components/boards-list", () => ({ BoardsList: () => null }));
vi.mock("@/components/dashboards-list", () => ({
  DashboardsList: () => null,
}));

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

  it("shows a failed workspace read as an error with a retry, not as not found", () => {
    mockScopedSWR({
      "/workspaces/ws1": { error: { status: 500, message: "Server error" } },
    });
    renderList(<Workspace />);

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByText("Workspace not found")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mutate).toHaveBeenCalled();
  });
});
