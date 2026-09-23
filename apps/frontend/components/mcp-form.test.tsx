import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { MCP } from "@platypus/schemas";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  setData,
  setError,
  resetFormHarness,
  stubRejectedSave,
} from "@/lib/form-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("next/navigation", () => navigationMock);
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

describe("McpForm record revalidation", () => {
  afterEach(() => {
    resetFormHarness();
    vi.restoreAllMocks();
  });

  it("keeps an unsaved edit when the OAuth status flips underneath it", () => {
    const mcp = {
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "OAuth",
      oauthClientId: "client-id",
      oauthAuthorized: false,
    };
    setData(mcp);
    const { rerender } = render(<McpForm orgId="org1" mcpId="m1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Edited" },
    });
    // What `mutateMcp()` after Authorize delivers: the same row, now authorized.
    setData({ ...mcp, oauthAuthorized: true });
    rerender(<McpForm orgId="org1" mcpId="m1" />);

    expect(screen.getByLabelText("Name")).toHaveValue("Edited");
    expect(screen.getByText("Authorized")).toBeInTheDocument();
  });
});

describe("McpForm detail read failures", () => {
  afterEach(() => {
    resetFormHarness();
    vi.restoreAllMocks();
  });

  it("shows a not-found state with the way back when the MCP is gone", () => {
    setError({ status: 404 });

    render(<McpForm orgId="org1" workspaceId="ws1" mcpId="m1" />);

    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to MCP servers" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/settings/mcp");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("shows the failure state on a server error, not a blank editable form", () => {
    setError({ status: 500 });

    render(<McpForm orgId="org1" mcpId="m1" />);

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });
});
