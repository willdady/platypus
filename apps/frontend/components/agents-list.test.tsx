import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { Agent, Provider } from "@platypus/schemas";
import {
  authMock,
  navigationMock,
  toastMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  jsonResponse,
  push,
  mutate,
  toastError,
  toastInfo,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => navigationMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { AgentsList } from "./agents-list";

// --- Fixtures ----------------------------------------------------------------

type AgentWithScope = Agent & { scope?: "organization" | "workspace" };

const orgAgent: AgentWithScope = {
  id: "a1",
  name: "Shared Agent",
  description: "desc",
  scope: "organization",
} as unknown as AgentWithScope;

const workspaceAgent: AgentWithScope = {
  id: "a2",
  name: "Workspace Agent",
  description: "desc",
  scope: "workspace",
} as unknown as AgentWithScope;

const provider: Provider = { id: "p1", name: "OpenAI" } as unknown as Provider;

/** Renders the Workspace surface with `agents` in the list. */
function renderAgents(agents: AgentWithScope[], menuItem?: string) {
  mockScopedSWR({ "/agents": agents, "/providers": [provider] });
  return renderList(<AgentsList orgId="org1" workspaceId="ws1" />, menuItem);
}

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("AgentsList detach", () => {
  it("surfaces the backend's reason and keeps the row when detach is refused", async () => {
    const fetchMock = stubRejectedSave(
      "This agent is a sub-agent elsewhere",
      409,
    );

    renderAgents([orgAgent], "Detach");
    await confirmDialog(/Detach/);

    await waitFor(() =>
      expect(
        screen.getByText("This agent is a sub-agent elsewhere"),
      ).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Detach shared agent")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/attachments/agent/a1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates and closes the dialog when detach succeeds", async () => {
    stubAcceptedSave();

    renderAgents([orgAgent], "Detach");
    await confirmDialog(/Detach/);

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(screen.queryByText("Detach shared agent")).not.toBeInTheDocument();
  });
});

describe("AgentsList delete", () => {
  it("deletes the workspace-scoped agent through the request module", async () => {
    const fetchMock = stubAcceptedSave();

    renderAgents([workspaceAgent], "Delete");
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents/a2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows the backend's guidance, not an error, when delete is refused because the agent is Shared", async () => {
    stubRejectedSave("This agent is managed at the organization level", 403);

    renderAgents([workspaceAgent], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith(
        "This agent is managed at the organization level",
      ),
    );
    expect(toastError).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete Agent")).not.toBeInTheDocument();
  });

  it("surfaces the backend's reason inline when delete fails for another reason", async () => {
    stubRejectedSave("Agent is in use", 409);

    renderAgents([workspaceAgent], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(screen.getByText("Agent is in use")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("AgentsList clone", () => {
  it("navigates to the new agent on success", async () => {
    const fetchMock = stubAcceptedSave({ id: "a3", name: "Cloned" }, 201);

    renderAgents([workspaceAgent], "Clone");
    await confirmDialog("Clone");

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/org1/workspace/ws1/agents/a3"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces the backend's reason when clone fails", async () => {
    stubRejectedSave("Name already in use", 409);

    renderAgents([workspaceAgent], "Clone");
    await confirmDialog("Clone");

    await waitFor(() =>
      expect(screen.getByText("Name already in use")).toBeInTheDocument(),
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe("AgentsList promote", () => {
  it("surfaces blockers from a refused promote", async () => {
    // Not `stubRejectedSave`: a refused promote carries its blockers beside
    // the reason, which that helper's `{ error }` body has no room for.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(422, {
        error: "Promote blocked",
        blockers: [{ type: "skill", id: "s1", name: "Private Skill" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderAgents([workspaceAgent], "Promote to organization");
    await confirmDialog("Promote");

    await waitFor(() =>
      expect(screen.getByText("Private Skill")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents/a2/promote",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("AgentsList list states", () => {
  it("shows the empty state when the workspace has no agents", () => {
    renderAgents([]);

    expect(
      screen.getByText("No agents yet. Create one to get started."),
    ).toBeInTheDocument();
  });

  it("shows the loading state while the read is in flight", () => {
    mockScopedSWR({
      "/agents": { isLoading: true },
      "/providers": [provider],
    });
    renderList(<AgentsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", () => {
    mockScopedSWR({
      "/agents": { error: new Error("500") },
      "/providers": [provider],
    });
    renderList(<AgentsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText(/Failed to load/i)).toBeInTheDocument();
  });
});
