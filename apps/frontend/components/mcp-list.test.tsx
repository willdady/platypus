import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { MCP } from "@platypus/schemas";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isOrgAdmin: true,
    actor: "org-admin",
    workspaceDelegation: null,
  }),
}));

type McpWithScope = MCP & { scope?: "organization" | "workspace" };

// The `GET .../mcps` list this component renders. Set per test.
let mcps: McpWithScope[] = [];

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key?.includes("/mcps")) {
      return {
        data: { results: mcps },
        error: undefined,
        isLoading: false,
        mutate: mutateSpy,
      };
    }
    return {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
}));

const mutateSpy = vi.fn();

import { McpList } from "./mcp-list";

// --- Helpers -----------------------------------------------------------------

const orgMcp: McpWithScope = {
  id: "m1",
  name: "Shared MCP",
  scope: "organization",
} as unknown as McpWithScope;

/** A refused detach, carrying the reason the backend gave. */
function mockRefusedDetach(reason: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ error: reason }),
  } as unknown as Response);
}

function openDetachDialog() {
  fireEvent.click(screen.getByText("Shared MCP"));
}

// --- Tests -------------------------------------------------------------------

describe("McpList detach", () => {
  afterEach(() => {
    mcps = [];
    mutateSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("surfaces the backend's reason and keeps the row when detach is refused", async () => {
    mcps = [orgMcp];
    const fetchMock = mockRefusedDetach(
      "This MCP server is in use by an agent in this workspace",
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<McpList orgId="org1" workspaceId="ws1" />);
    openDetachDialog();
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This MCP server is in use by an agent in this workspace",
        ),
      ).toBeInTheDocument(),
    );

    // A refused detach must not revalidate the list.
    expect(mutateSpy).not.toHaveBeenCalled();
    // The dialog stays open on the same MCP rather than silently closing.
    expect(screen.getByText("Organization MCP")).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/attachments/mcp/m1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("revalidates and closes the dialog when detach succeeds", async () => {
    mcps = [orgMcp];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: "Detached" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<McpList orgId="org1" workspaceId="ws1" />);
    openDetachDialog();
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(screen.queryByText("Organization MCP")).not.toBeInTheDocument();
  });
});
