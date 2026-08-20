import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { MCP } from "@platypus/schemas";

// --- Module mocks ------------------------------------------------------------

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

// The MCP the edit form loads. Set per test before rendering.
let loadedMcp: MCP | undefined;

vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: loadedMcp,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

import { McpForm } from "./mcp-form";
import { toast } from "sonner";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

// --- Tests -------------------------------------------------------------------

describe("McpForm secret reveal", () => {
  afterEach(() => {
    loadedMcp = undefined;
    vi.restoreAllMocks();
  });

  it("toggles the bearer token between masked and revealed", () => {
    loadedMcp = {
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "Bearer",
      bearerToken: "secret-token",
    } as unknown as MCP;
    render(<McpForm orgId="org1" mcpId="m1" />);

    const input = screen.getByLabelText("Bearer Token");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show bearer token" }));
    expect(input).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "Hide bearer token" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("toggles the OAuth client secret between masked and revealed", () => {
    loadedMcp = {
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "OAuth",
      oauthClientId: "client-id",
    } as unknown as MCP;
    render(<McpForm orgId="org1" mcpId="m1" />);

    const input = screen.getByLabelText("Client Secret");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show client secret" }));
    expect(input).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "Hide client secret" }));
    expect(input).toHaveAttribute("type", "password");
  });
});

describe("McpForm locked delete", () => {
  afterEach(() => {
    loadedMcp = undefined;
    vi.restoreAllMocks();
  });

  it("shows the backend's guidance, not an error toast, when the MCP is Shared", async () => {
    loadedMcp = {
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "None",
    } as unknown as MCP;
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        error: "This MCP server is managed at the organization level",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<McpForm orgId="org1" workspaceId="ws1" mcpId="m1" />);

    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith(
        "This MCP server is managed at the organization level",
      ),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});
