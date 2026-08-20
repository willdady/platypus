import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { MCP } from "@platypus/schemas";
import {
  navigationMock,
  configMock,
  authMock,
  toastMock,
  swrMock,
  setData,
  resetFormHarness,
  stubRejectedSave,
} from "@/lib/form-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/app/client-context", () => configMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { McpForm } from "./mcp-form";
import { toast } from "sonner";

// --- Tests -------------------------------------------------------------------

describe("McpForm secret reveal", () => {
  afterEach(() => {
    resetFormHarness();
    vi.restoreAllMocks();
  });

  it("toggles the bearer token between masked and revealed", () => {
    setData({
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "Bearer",
      bearerToken: "secret-token",
    } as unknown as MCP);
    render(<McpForm orgId="org1" mcpId="m1" />);

    const input = screen.getByLabelText("Bearer Token");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: "Show bearer token" }));
    expect(input).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "Hide bearer token" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("toggles the OAuth client secret between masked and revealed", () => {
    setData({
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "OAuth",
      oauthClientId: "client-id",
    } as unknown as MCP);
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
    resetFormHarness();
    vi.restoreAllMocks();
  });

  it("shows the backend's guidance, not an error toast, when the MCP is Shared", async () => {
    setData({
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "None",
    } as unknown as MCP);
    stubRejectedSave(
      "This MCP server is managed at the organization level",
      403,
    );

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
