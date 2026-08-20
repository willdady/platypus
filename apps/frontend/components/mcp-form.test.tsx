import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
