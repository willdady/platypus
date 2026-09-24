import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { Agent } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubSaveSequence,
  stubAcceptedSave,
  mutate,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { OrgAgentsList } from "./org-agents-list";

// --- Fixtures ----------------------------------------------------------------

const sharedAgent: Agent = {
  id: "a1",
  name: "Shared Agent",
  description: "desc",
} as unknown as Agent;

/** Renders the Organization surface with `agents` in the list. */
function renderAgents(agents: Agent[], menuItem?: string) {
  mockScopedSWR({ "/agents": agents });
  return renderList(<OrgAgentsList orgId="org1" />, menuItem);
}

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("OrgAgentsList delete", () => {
  it("blocks delete and reports the attachment count when the agent is still attached", async () => {
    const fetchMock = stubAcceptedSave({ results: [{ id: "att1" }] });

    renderAgents([sharedAgent], "Delete");

    await waitFor(() =>
      expect(screen.getByText("Can't delete shared agent")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/attachments?resourceType=agent&resourceId=a1",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("surfaces the backend's reason and keeps the agent when delete fails", async () => {
    // The attachment-count check first, then the delete itself.
    const fetchMock = stubSaveSequence(
      { status: 200, body: { results: [] } },
      { status: 409, body: { error: "Still referenced" } },
    );

    renderAgents([sharedAgent], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(screen.getByText("Still referenced")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/agents/a1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates when delete succeeds", async () => {
    stubSaveSequence(
      { status: 200, body: { results: [] } },
      { status: 200, body: {} },
    );

    renderAgents([sharedAgent], "Delete");
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });
});

describe("OrgAgentsList list states", () => {
  it("shows the empty state when the organization shares no agents", () => {
    renderAgents([]);

    expect(screen.getByText(/No shared agents yet/i)).toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", () => {
    mockScopedSWR({ "/agents": { error: new Error("500") } });
    renderList(<OrgAgentsList orgId="org1" />);

    expect(
      screen.getByText(/Failed to load shared agents/),
    ).toBeInTheDocument();
  });

  it("holds the grid with a skeleton, not the empty state, while loading", () => {
    mockScopedSWR({ "/agents": { isLoading: true } });
    renderList(<OrgAgentsList orgId="org1" />);

    expect(
      screen.getByRole("status", { name: "Loading shared agents" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/No shared agents yet/i)).not.toBeInTheDocument();
  });
});
