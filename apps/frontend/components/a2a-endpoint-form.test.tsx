import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  navigationMock,
  authMock,
  authState,
  toastMock,
  swrMock,
  push,
  resetFormHarness,
  setDataFor,
  stubAcceptedSave,
  savedBody,
} from "@/lib/form-test-harness";
import { selectOption } from "@/lib/test-utils";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { A2aEndpointForm } from "./a2a-endpoint-form";

const endpoint = {
  id: "ep-1",
  workspaceId: "ws1",
  agentId: "agent-1",
  name: "Acme helpdesk",
  description: "Ask about your order",
  enabled: true,
  includeMemories: false,
  extractMemories: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  tokens: [
    {
      id: "tok-1",
      endpointId: "ep-1",
      name: "Hermes",
      tokenStatus: "expiring",
      tokenCreatedAt: "2026-09-02T00:00:00.000Z",
      tokenExpiresAt: "2026-10-02T00:00:00.000Z",
      lastUsedAt: null,
      lastRejectedAt: "2026-09-20T10:00:00.000Z",
      createdAt: "2026-09-02T00:00:00.000Z",
    },
  ],
};

const asOwner = (owns: boolean) =>
  Object.assign(authState, { ownsWorkspace: owns });

beforeEach(() => {
  resetFormHarness();
  asOwner(true);
  setDataFor("/agents", {
    results: [
      { id: "agent-1", name: "Helper", description: "Internal" },
      { id: "agent-2", name: "Scout", description: "Finds things" },
    ],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2aEndpointForm", () => {
  it("leaves the runs-act-as-you warning to the endpoints list", () => {
    render(<A2aEndpointForm orgId="org1" workspaceId="ws1" />);

    expect(
      screen.queryByText("Runs act as you, with all of the agent's tools"),
    ).not.toBeInTheDocument();
  });

  it("fills the name and description from the agent picked", async () => {
    render(<A2aEndpointForm orgId="org1" workspaceId="ws1" />);

    await selectOption("Select an agent", "Helper");
    expect(screen.getByLabelText("Name")).toHaveValue("Helper");
    expect(screen.getByLabelText("Description")).toHaveValue("Internal");

    // A fill the Owner hasn't touched follows the next pick.
    await selectOption("Helper", "Scout");
    expect(screen.getByLabelText("Name")).toHaveValue("Scout");
    expect(screen.getByLabelText("Description")).toHaveValue("Finds things");
  });

  it("keeps a name and description the Owner typed when an agent is picked", async () => {
    render(<A2aEndpointForm orgId="org1" workspaceId="ws1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Acme helpdesk" },
    });
    await selectOption("Select an agent", "Helper");
    expect(screen.getByLabelText("Name")).toHaveValue("Acme helpdesk");
    expect(screen.getByLabelText("Description")).toHaveValue("Internal");

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Ask about your order" },
    });
    await selectOption("Helper", "Scout");
    expect(screen.getByLabelText("Name")).toHaveValue("Acme helpdesk");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Ask about your order",
    );
  });

  it("creates an endpoint, then opens it at its URL and tokens", async () => {
    const fetchMock = stubAcceptedSave({ ...endpoint, tokens: undefined });
    render(<A2aEndpointForm orgId="org1" workspaceId="ws1" />);

    await selectOption("Select an agent", "Helper");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        "/org1/workspace/ws1/settings/a2a-endpoints/ep-1#access",
      ),
    );
    expect(savedBody(fetchMock)).toEqual({
      agentId: "agent-1",
      name: "Helper",
      description: "Internal",
      enabled: true,
      includeMemories: false,
      extractMemories: false,
    });
  });

  it("lands on the token name when opened just after create", async () => {
    window.location.hash = "#access";
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      setDataFor("/a2a-endpoints/ep-1", endpoint);
      render(
        <A2aEndpointForm orgId="org1" workspaceId="ws1" endpointId="ep-1" />,
      );

      await waitFor(() =>
        expect(screen.getByLabelText("Token name")).toHaveFocus(),
      );
      expect(scrollIntoView).toHaveBeenCalled();
      expect(window.location.hash).toBe("");
    } finally {
      Element.prototype.scrollIntoView = original;
      window.location.hash = "";
    }
  });

  it("turns on both memory settings", async () => {
    setDataFor("/a2a-endpoints/ep-1", endpoint);
    const fetchMock = stubAcceptedSave(endpoint);
    render(
      <A2aEndpointForm orgId="org1" workspaceId="ws1" endpointId="ep-1" />,
    );

    const include = screen.getByRole("switch", { name: /Include Memories/ });
    const extract = screen.getByRole("switch", { name: /Extract Memories/ });
    expect(include).not.toBeChecked();
    expect(extract).not.toBeChecked();
    fireEvent.click(include);
    fireEvent.click(extract);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));

    await waitFor(() =>
      expect(savedBody(fetchMock)).toEqual({
        name: "Acme helpdesk",
        description: "Ask about your order",
        enabled: true,
        includeMemories: true,
        extractMemories: true,
      }),
    );
  });

  it("shows the card URL and a new token once", async () => {
    setDataFor("/a2a-endpoints/ep-1", endpoint);
    const fetchMock = stubAcceptedSave({
      id: "tok-2",
      endpointId: "ep-1",
      name: "Rovo",
      createdAt: "2026-09-03T00:00:00.000Z",
      token: "pa2a_secret",
    });
    render(
      <A2aEndpointForm orgId="org1" workspaceId="ws1" endpointId="ep-1" />,
    );

    expect(screen.getByLabelText("Agent card URL")).toHaveValue(
      "http://test/a2a/ep-1/.well-known/agent-card.json",
    );
    expect(screen.getByText("Hermes")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Token name"), {
      target: { value: "Rovo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add token" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Token")).toHaveValue("pa2a_secret"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/a2a-endpoints/ep-1/tokens",
      expect.objectContaining({ method: "POST" }),
    );
    expect(savedBody(fetchMock)).toEqual({ name: "Rovo", expiryDays: 90 });

    fireEvent.click(screen.getByRole("button", { name: "I've copied it" }));
    expect(screen.queryByDisplayValue("pa2a_secret")).not.toBeInTheDocument();
  });

  it("shows each token's status, expiry, last used and last rejected", () => {
    setDataFor("/a2a-endpoints/ep-1", endpoint);
    render(
      <A2aEndpointForm orgId="org1" workspaceId="ws1" endpointId="ep-1" />,
    );

    expect(screen.getByText("Expiring soon")).toBeInTheDocument();
    expect(screen.getByText(/Expires .*2026/)).toBeInTheDocument();
    expect(screen.getByText(/Last used never/)).toBeInTheDocument();
    expect(screen.getByText(/Last rejected .*2026/)).toBeInTheDocument();
  });

  it("issues a token with the lifetime picked", async () => {
    setDataFor("/a2a-endpoints/ep-1", endpoint);
    const fetchMock = stubAcceptedSave({ ...endpoint.tokens[0], token: "x" });
    render(
      <A2aEndpointForm orgId="org1" workspaceId="ws1" endpointId="ep-1" />,
    );

    fireEvent.change(screen.getByLabelText("Token name"), {
      target: { value: "Rovo" },
    });
    await selectOption("90 days", "365 days");
    fireEvent.click(screen.getByRole("button", { name: "Add token" }));

    await waitFor(() =>
      expect(savedBody(fetchMock)).toEqual({ name: "Rovo", expiryDays: 365 }),
    );
  });

  it("regenerates a token after confirming, and shows the new one once", async () => {
    setDataFor("/a2a-endpoints/ep-1", endpoint);
    const fetchMock = stubAcceptedSave({
      ...endpoint.tokens[0],
      token: "pa2a_fresh",
    });
    render(
      <A2aEndpointForm orgId="org1" workspaceId="ws1" endpointId="ep-1" />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Regenerate token Hermes" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));

    await waitFor(() =>
      expect(screen.getByLabelText("Token")).toHaveValue("pa2a_fresh"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/a2a-endpoints/ep-1/tokens/tok-1/regenerate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("is read-only for an Org Admin in another Owner's workspace", () => {
    asOwner(false);
    setDataFor("/a2a-endpoints/ep-1", endpoint);
    render(
      <A2aEndpointForm orgId="org1" workspaceId="ws1" endpointId="ep-1" />,
    );

    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByText("Hermes")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Update" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add token" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete token Hermes" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Regenerate token Hermes" }),
    ).not.toBeInTheDocument();
  });
});
