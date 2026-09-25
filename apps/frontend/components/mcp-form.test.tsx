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
  stubAcceptedSave,
  stubRejectedSave,
  stubSaveSequence,
  savedBody,
} from "@/lib/form-test-harness";
import { selectOption } from "@/lib/test-utils";
import { OAUTH_MCP_SUCCESS_EVENT } from "@/lib/constants";

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

describe("McpForm save payload", () => {
  afterEach(() => {
    resetFormHarness();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // A stored bearer token must not ride along once Auth no longer uses it,
  // and a header row with no name is dropped rather than sent as "".
  it("sends only the credential the chosen Auth uses, and only named headers", async () => {
    setData({
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "Bearer",
      bearerToken: "secret-token",
      headers: { "X-Api": "1" },
    } as unknown as MCP);
    const fetchMock = stubAcceptedSave({ id: "m1" });
    render(<McpForm orgId="org1" workspaceId="ws1" mcpId="m1" />);

    await selectOption(screen.getByRole("combobox", { name: "Auth" }), "None");
    fireEvent.click(screen.getByRole("button", { name: "Add header" }));
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test/organizations/org1/workspaces/ws1/mcps/m1",
    );
    expect(savedBody(fetchMock)).toEqual({
      workspaceId: "ws1",
      name: "Docs",
      url: "http://mcp.test",
      headers: { "X-Api": "1" },
      authType: "None",
    });
  });

  // A blank Client Secret on an edit means "keep the stored one", so it is
  // left off the wire rather than overwriting the secret with "".
  it("keeps the stored client secret and trims the scopes on an Organization MCP", async () => {
    setData({
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "OAuth",
      oauthClientId: "client-id",
      oauthRequestedScope: "  calendar email  ",
    } as unknown as MCP);
    const fetchMock = stubAcceptedSave({ id: "m1" });
    render(<McpForm orgId="org1" mcpId="m1" />);

    expect(screen.getByLabelText("Client Secret")).toHaveAttribute(
      "placeholder",
      "Leave blank to keep current",
    );
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test/organizations/org1/mcps/m1",
    );
    expect(savedBody(fetchMock)).toEqual({
      organizationId: "org1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "OAuth",
      oauthClientId: "client-id",
      oauthRequestedScope: "calendar email",
    });
  });
});

describe("McpForm test connection", () => {
  afterEach(() => {
    resetFormHarness();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderBearerMcp = () => {
    setData({
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "Bearer",
      bearerToken: "secret-token",
    } as unknown as MCP);
    render(<McpForm orgId="org1" workspaceId="ws1" mcpId="m1" />);
  };

  it("tests the unsaved form and lists the tools, flagging names too long to namespace", async () => {
    const fetchMock = stubAcceptedSave({
      success: true,
      toolNames: ["docs_search"],
      invalidToolNames: ["docs_a_very_long_tool_name"],
    });
    renderBearerMcp();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(
      await screen.findByText("Connection successful"),
    ).toBeInTheDocument();
    expect(screen.getByText("Found 1 tool")).toBeInTheDocument();
    expect(screen.getByText("docs_search")).toBeInTheDocument();
    expect(screen.getByText(/names are too long/)).toBeInTheDocument();
    expect(screen.getByText("docs_a_very_long_tool_name")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test/organizations/org1/workspaces/ws1/mcps/test",
    );
    expect(savedBody(fetchMock)).toEqual({
      url: "http://mcp.test",
      authType: "Bearer",
      bearerToken: "secret-token",
      name: "Docs",
    });
  });

  it("shows why the connection failed, and drops the result once the form is edited", async () => {
    stubAcceptedSave({ success: false, error: "401 from upstream" });
    renderBearerMcp();

    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    expect(await screen.findByText("Connection failed")).toBeInTheDocument();
    expect(screen.getByText("401 from upstream")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("URL"), {
      target: { value: "http://other.test" },
    });

    expect(screen.queryByText("Connection failed")).toBeNull();
  });
});

describe("McpForm OAuth", () => {
  afterEach(() => {
    resetFormHarness();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderOAuthMcp = (oauthAuthorized: boolean) => {
    setData({
      id: "m1",
      name: "Docs",
      url: "http://mcp.test",
      authType: "OAuth",
      oauthClientId: "client-id",
      oauthAuthorized,
    } as unknown as MCP);
    render(<McpForm orgId="org1" workspaceId="ws1" mcpId="m1" />);
  };

  // The popup reports back by postMessage; only this app's own origin may
  // declare the authorization complete.
  it("accepts an OAuth completion message only from its own origin", () => {
    renderOAuthMcp(false);
    const completion = (origin: string) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin,
          data: { type: OAUTH_MCP_SUCCESS_EVENT },
        }),
      );

    completion("https://evil.test");
    expect(toast.success).not.toHaveBeenCalled();

    completion(window.location.origin);
    expect(toast.success).toHaveBeenCalledWith("OAuth authorization completed");
  });

  // Without force, a still-valid refresh token would rotate silently and the
  // reader who asked to re-authorize would never see the provider.
  it("saves, then forces a fresh flow when re-authorizing", async () => {
    const fetchMock = stubSaveSequence(
      { status: 200, body: { id: "m1" } },
      { status: 200, body: { alreadyAuthorized: true } },
    );
    renderOAuthMcp(true);

    fireEvent.click(screen.getByRole("button", { name: "Re-authorize" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Already authorized"),
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://test/organizations/org1/workspaces/ws1/mcps/m1",
      "http://test/organizations/org1/workspaces/ws1/mcps/m1/oauth/authorize?force=true",
    ]);
  });
});
