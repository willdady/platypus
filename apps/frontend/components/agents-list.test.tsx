import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Agent, Provider } from "@platypus/schemas";
import {
  installRadixPointerPolyfills,
  openDropdownMenu as openMenu,
} from "@/lib/test-utils";

beforeAll(installRadixPointerPolyfills);

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isOrgAdmin: true,
    actor: "org-admin",
  }),
}));

const pushSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushSpy }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

type AgentWithScope = Agent & { scope?: "organization" | "workspace" };

// The `GET .../agents` list this component renders. Set per test.
let agents: AgentWithScope[] = [];
const provider: Provider = { id: "p1", name: "OpenAI" } as unknown as Provider;

const mutateSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key?.includes("/agents")) {
      return {
        data: { results: agents },
        isLoading: false,
        mutate: mutateSpy,
      };
    }
    if (key?.includes("/providers")) {
      return { data: { results: [provider] }, isLoading: false };
    }
    return { data: { results: [] }, isLoading: false };
  },
}));

import { AgentsList } from "./agents-list";
import { toast } from "sonner";

// --- Helpers -----------------------------------------------------------------

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

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  agents = [];
  mutateSpy.mockClear();
  pushSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("AgentsList detach", () => {
  it("surfaces the backend's reason and keeps the row when detach is refused", async () => {
    agents = [orgAgent];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: "This agent is a sub-agent elsewhere" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Detach"));
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

    await waitFor(() =>
      expect(
        screen.getByText("This agent is a sub-agent elsewhere"),
      ).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(screen.getByText("Detach shared agent")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/attachments/agent/a1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates and closes the dialog when detach succeeds", async () => {
    agents = [orgAgent];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Detach"));
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(screen.queryByText("Detach shared agent")).not.toBeInTheDocument();
  });
});

describe("AgentsList delete", () => {
  it("deletes the workspace-scoped agent through the request module", async () => {
    agents = [workspaceAgent];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents/a2",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows the backend's guidance, not an error, when delete is refused because the agent is Shared", async () => {
    agents = [workspaceAgent];
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        error: "This agent is managed at the organization level",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "This agent is managed at the organization level",
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete Agent")).not.toBeInTheDocument();
  });

  it("surfaces the backend's reason inline when delete fails for another reason", async () => {
    agents = [workspaceAgent];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Agent is in use" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("Agent is in use")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
  });
});

describe("AgentsList clone", () => {
  it("navigates to the new agent on success", async () => {
    agents = [workspaceAgent];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(201, { id: "a3", name: "Cloned" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Clone"));
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));

    await waitFor(() =>
      expect(pushSpy).toHaveBeenCalledWith("/org1/workspace/ws1/agents/a3"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("surfaces the backend's reason when clone fails", async () => {
    agents = [workspaceAgent];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "Name already in use" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Clone"));
    fireEvent.click(screen.getByRole("button", { name: "Clone" }));

    await waitFor(() =>
      expect(screen.getByText("Name already in use")).toBeInTheDocument(),
    );
    expect(pushSpy).not.toHaveBeenCalled();
  });
});

describe("AgentsList promote", () => {
  it("surfaces blockers from a refused promote", async () => {
    agents = [workspaceAgent];
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(422, {
        error: "Promote blocked",
        blockers: [{ type: "skill", id: "s1", name: "Private Skill" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<AgentsList orgId="org1" workspaceId="ws1" />);
    openMenu();
    fireEvent.click(screen.getByText("Promote to organization"));
    fireEvent.click(screen.getByRole("button", { name: "Promote" }));

    await waitFor(() =>
      expect(screen.getByText("Private Skill")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/agents/a2/promote",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
