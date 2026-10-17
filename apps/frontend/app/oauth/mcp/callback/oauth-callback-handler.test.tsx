import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { stubAcceptedSave, stubRejectedSave } from "@/test/test-utils";
import {
  OAUTH_MCP_ERROR_EVENT,
  OAUTH_MCP_SUCCESS_EVENT,
} from "@/lib/constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));

import { OAuthCallbackHandler } from "./oauth-callback-handler";

describe("OAuthCallbackHandler", () => {
  it("posts the single-use code once, even under StrictMode", async () => {
    const fetchMock = stubRejectedSave("Invalid state", 400);

    render(
      <StrictMode>
        <OAuthCallbackHandler code="c1" state="s1" />
      </StrictMode>,
    );

    await screen.findByText("Invalid state");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("names the provider's error instead of a missing code", () => {
    const fetchMock = stubAcceptedSave({});

    render(
      <OAuthCallbackHandler
        state="s1"
        error="access_denied"
        errorDescription="The user denied access"
      />,
    );

    expect(screen.getByText(/The user denied access/)).toBeInTheDocument();
    expect(
      screen.queryByText(/Missing authorization code/),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the provider's error code when it gives no description", () => {
    render(<OAuthCallbackHandler state="s1" error="access_denied" />);

    expect(screen.getByText(/access_denied/)).toBeInTheDocument();
  });

  it("still reports a missing code when the provider sent no error", async () => {
    render(<OAuthCallbackHandler state="s1" />);

    expect(
      await screen.findByText("Missing authorization code or state parameter."),
    ).toBeInTheDocument();
  });

  describe("in a popup", () => {
    const postMessage = vi.fn();
    const close = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("opener", { closed: false, postMessage });
      vi.stubGlobal("close", close);
    });

    // The opener's form waits on this message; without it the Authorize
    // button never learns the outcome and the popup lingers.
    it("tells the opener which MCP was authorized, then closes", async () => {
      stubAcceptedSave({ mcpId: "m1", orgId: "o1", workspaceId: "w1" });

      render(<OAuthCallbackHandler code="c1" state="s1" />);

      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(postMessage).toHaveBeenCalledWith(
        { type: OAUTH_MCP_SUCCESS_EVENT, mcpId: "m1" },
        window.location.origin,
      );
    });

    // A failed exchange must reach the opener, where the reader can retry.
    it("hands a failed exchange to the opener, then closes", async () => {
      stubRejectedSave("Invalid state", 400);

      render(<OAuthCallbackHandler code="c1" state="s1" />);

      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(postMessage).toHaveBeenCalledWith(
        { type: OAUTH_MCP_ERROR_EVENT, message: "Invalid state" },
        window.location.origin,
      );
    });

    // A provider refusal never reaches the backend, so the opener hears it
    // from here or not at all.
    it("hands the provider's refusal to the opener", async () => {
      const fetchMock = stubAcceptedSave({});

      render(<OAuthCallbackHandler state="s1" error="access_denied" />);

      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(postMessage).toHaveBeenCalledWith(
        {
          type: OAUTH_MCP_ERROR_EVENT,
          message: "Authorization was refused: access_denied",
        },
        window.location.origin,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("without an opener", () => {
    const replace = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("location", { ...window.location, replace });
    });

    // A blocked popup fell back to this window, so the reader must land back
    // on the MCP they were authorizing.
    it("returns to the workspace MCP's edit page", async () => {
      stubAcceptedSave({ mcpId: "m1", orgId: "o1", workspaceId: "w1" });

      render(<OAuthCallbackHandler code="c1" state="s1" />);

      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith(
          "/o1/workspace/w1/settings/mcp/m1",
        ),
      );
    });

    // A Shared MCP has no Workspace; it is edited under the org settings.
    it("returns to the org settings for a Shared MCP", async () => {
      stubAcceptedSave({ mcpId: "m1", orgId: "o1" });

      render(<OAuthCallbackHandler code="c1" state="s1" />);

      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith("/o1/settings/mcp/m1"),
      );
    });

    // Under a BASE_PATH the bare app path would 404.
    it("prefixes the edit page with the base path", async () => {
      vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "/app");
      stubAcceptedSave({ mcpId: "m1", orgId: "o1" });

      render(<OAuthCallbackHandler code="c1" state="s1" />);

      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith("/app/o1/settings/mcp/m1"),
      );
    });
  });
});
