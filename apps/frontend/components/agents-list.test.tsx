import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Agent, Provider } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  authState,
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
  menuItemLabels,
} from "@/test/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import userEvent from "@testing-library/user-event";
import { openDropdownMenu, stubPendingSave } from "@/test/test-utils";
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

// --- Tests -------------------------------------------------------------------

describe("AgentsList detach", () => {
  it("surfaces the backend's reason and keeps the row when detach is refused", async () => {
    const fetchMock = stubRejectedSave(
      "This agent is a sub-agent elsewhere",
      409,
    );

    await renderAgents([orgAgent], "Detach");
    await confirmDialog(/Detach/);

    expect(
      await screen.findByText("This agent is a sub-agent elsewhere"),
    ).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Detach shared agent")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/attachments/agent/a1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates and closes the dialog when detach succeeds", async () => {
    stubAcceptedSave();

    await renderAgents([orgAgent], "Detach");
    await confirmDialog(/Detach/);

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(screen.queryByText("Detach shared agent")).not.toBeInTheDocument();
  });
});

describe("AgentsList delete", () => {
  it("deletes the workspace-scoped agent through the request module", async () => {
    const fetchMock = stubAcceptedSave();

    await renderAgents([workspaceAgent], "Delete");
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents/a2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows the backend's guidance, not an error, when delete is refused because the agent is Shared", async () => {
    stubRejectedSave("This agent is managed at the organization level", 403);

    await renderAgents([workspaceAgent], "Delete");
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

    await renderAgents([workspaceAgent], "Delete");
    await confirmDialog("Delete");

    expect(await screen.findByText("Agent is in use")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("AgentsList clone", () => {
  it("names the copy after the original", async () => {
    await renderAgents([workspaceAgent], "Clone");

    const name = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Name",
    });
    expect(name).toHaveValue("Workspace Agent (copy)");
    // Named by a visible label, as in other form dialogs.
    expect(name.labels?.[0]).toHaveTextContent("Name");
  });

  it("navigates to the new agent on success", async () => {
    const fetchMock = stubAcceptedSave({ id: "a3", name: "Cloned" }, 201);

    await renderAgents([workspaceAgent], "Clone");
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

    await renderAgents([workspaceAgent], "Clone");
    await confirmDialog("Clone");

    expect(await screen.findByText("Name already in use")).toBeInTheDocument();
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

    await renderAgents([workspaceAgent], "Promote to organization");
    await confirmDialog("Promote");

    expect(await screen.findByText("Private Skill")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents/a2/promote",
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("AgentsList pinning", () => {
  const agent = (id: string, name: string, isPinned = false) =>
    ({
      id,
      name,
      description: "desc",
      scope: "workspace",
      isPinned,
    }) as unknown as AgentWithScope;

  const namesIn = (list: string) =>
    within(screen.getByRole("list", { name: list }))
      .getAllByRole("listitem")
      .map((item) => within(item).getAllByText(/./)[0].textContent);

  beforeEach(() => {
    authState.ownsWorkspace = true;
  });

  afterEach(() => {
    delete authState.ownsWorkspace;
  });

  it("groups pinned agents above the rest, each sorted by name", async () => {
    await renderAgents([
      agent("a1", "Zed", true),
      agent("a2", "Mia"),
      agent("a3", "Abe", true),
      agent("a4", "Bob"),
    ]);

    expect(screen.getByRole("heading", { name: "Pinned" })).toBeInTheDocument();
    expect(namesIn("Pinned agents")).toEqual(["Abe", "Zed"]);
    expect(namesIn("Agents")).toEqual(["Bob", "Mia"]);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("shows no Pinned group when nothing is pinned", async () => {
    await renderAgents([agent("a2", "Mia"), agent("a4", "Bob")]);

    expect(
      screen.queryByRole("heading", { name: "Pinned" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(namesIn("Agents")).toEqual(["Bob", "Mia"]);
  });

  it.each([
    ["a workspace agent", workspaceAgent],
    ["an attached shared agent", orgAgent],
  ])("lets the Owner pin %s", async (_label, target) => {
    authState.actor = "workspace-owner";
    const fetchMock = stubAcceptedSave();

    await renderAgents([target], "Pin");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      `http://test/organizations/org1/workspaces/ws1/agents/${target.id}/pin`,
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("lets the Owner unpin a pinned agent", async () => {
    const fetchMock = stubAcceptedSave();

    await renderAgents([agent("a2", "Mia", true)], "Unpin");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents/a2/pin",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("pins at once and sends one pin while the first is in flight, however often it is picked", async () => {
    const { fetchMock, resolve } = stubPendingSave();

    await renderAgents([workspaceAgent], "Pin");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(namesIn("Pinned agents")).toEqual([workspaceAgent.name]);

    await openDropdownMenu();
    const pending = screen.getByRole("menuitem", { name: /Unpin/ });
    expect(pending).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(pending);
    expect(fetchMock).toHaveBeenCalledOnce();

    resolve();
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });

  it("surfaces the backend's reason when a pin is refused", async () => {
    stubRejectedSave("Agent not found", 404);

    await renderAgents([workspaceAgent], "Pin");

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Agent not found"),
    );
    // The optimistic pin reverts.
    expect(
      screen.queryByRole("list", { name: "Pinned agents" }),
    ).not.toBeInTheDocument();
  });

  // The backend refuses a pin from anyone but the Workspace Owner, an Org
  // Admin included, so offering it would only produce an error.
  it("offers a non-owner no Pin or Unpin", async () => {
    authState.ownsWorkspace = false;

    await renderAgents([agent("a2", "Mia", true), agent("a4", "Bob")]);
    for (const trigger of screen.getAllByRole("button", {
      name: /Actions for/,
    })) {
      fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(trigger, { button: 0, pointerId: 1 });
      fireEvent.click(trigger, { button: 0 });
      expect(screen.queryByText(/^(Un)?pin$/)).not.toBeInTheDocument();
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: "Escape",
      });
    }
    // The pinned grouping is still shown to them.
    expect(namesIn("Pinned agents")).toEqual(["Mia"]);
  });
});

describe("AgentsList list states", () => {
  it("shows the empty state when the workspace has no agents", async () => {
    await renderAgents([]);

    expect(screen.getByText("No agents yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Create agent/ })).toHaveAttribute(
      "href",
      expect.stringContaining("/agents/create"),
    );
  });

  it("holds the card grid with a skeleton while the read is in flight", async () => {
    mockScopedSWR({
      "/agents": { isLoading: true },
      "/providers": [provider],
    });
    await renderList(<AgentsList orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByRole("status", { name: "Loading agents" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("No agents yet")).not.toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", async () => {
    mockScopedSWR({
      "/agents": { error: new Error("500") },
      "/providers": [provider],
    });
    await renderList(<AgentsList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText(/Failed to load/i)).toBeInTheDocument();
  });
});

describe("AgentsList card height", () => {
  it("reserves a three-line description box, with the full text on hover", async () => {
    await renderAgents([workspaceAgent]);

    const description = screen.getByText("desc");
    expect(description).toHaveClass("line-clamp-3", "min-h-[3lh]");
    expect(description).toHaveAttribute("title", "desc");
  });

  it("keeps the description box when there is no description", async () => {
    await renderAgents([{ ...workspaceAgent, description: "" }]);

    expect(screen.getByRole("paragraph")).toHaveClass("min-h-[3lh]");
  });

  it("counts tool sets, skills and sub-agents in singular and plural", async () => {
    mockScopedSWR({
      "/tools": [
        { id: "t1", name: "Search" },
        { id: "t2", name: "Files" },
      ],
      "/skills": [{ id: "s1", name: "Writing" }],
    });
    await renderAgents([
      { ...workspaceAgent, toolSetIds: ["t1", "t2"], skillIds: ["s1"] },
    ]);

    expect(screen.getByText("2 tool sets")).toBeInTheDocument();
    expect(screen.getByText("1 skill")).toBeInTheDocument();
    expect(screen.getByText("0 sub-agents")).toBeInTheDocument();
    await userEvent.hover(screen.getByText("2 tool sets"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Search");
  });
});

describe("AgentsList card actions", () => {
  it("renders each card's New chat and menu once", async () => {
    await renderAgents([workspaceAgent, orgAgent]);

    for (const item of screen.getAllByRole("listitem")) {
      expect(
        within(item).getAllByRole("link", { name: /New chat/ }),
      ).toHaveLength(1);
      expect(item.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(1);
    }
  });

  it("draws each skeleton card's actions once", async () => {
    mockScopedSWR({
      "/agents": { isLoading: true },
      "/providers": [provider],
    });
    await renderList(<AgentsList orgId="org1" workspaceId="ws1" />);

    const cards = screen.getAllByRole("listitem");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.querySelectorAll('[data-slot="item-actions"]')).toHaveLength(
        1,
      );
    }
  });
});

describe("AgentsList menu", () => {
  afterEach(() => {
    authState.ownsWorkspace = undefined;
  });

  it("orders an agent's menu Edit, its own items, Clone, then Delete", async () => {
    authState.ownsWorkspace = true;

    await renderAgents([workspaceAgent]);
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual([
      "Edit",
      "Pin",
      "Promote to organization",
      "Clone",
      "Delete",
    ]);
  });

  it("orders a shared agent's menu Edit in org settings, Pin, then Detach", async () => {
    authState.ownsWorkspace = true;

    await renderAgents([orgAgent]);
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit in org settings", "Pin", "Detach"]);
  });
});
