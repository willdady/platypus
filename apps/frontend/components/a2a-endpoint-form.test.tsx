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
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  tokens: [
    {
      id: "tok-1",
      endpointId: "ep-1",
      name: "Hermes",
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
    results: [{ id: "agent-1", name: "Helper", description: "Internal" }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("A2aEndpointForm", () => {
  it("warns that runs act as the Owner with all of the agent's tools", () => {
    render(<A2aEndpointForm orgId="org1" workspaceId="ws1" />);

    expect(
      screen.getByText("Runs act as you, with all of the agent's tools"),
    ).toBeInTheDocument();
  });

  it("creates an endpoint, leaving a blank name and description to the agent's, then opens it", async () => {
    const fetchMock = stubAcceptedSave({ ...endpoint, tokens: undefined });
    render(<A2aEndpointForm orgId="org1" workspaceId="ws1" />);

    await selectOption("Select an agent", "Helper");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith(
        "/org1/workspace/ws1/settings/a2a-endpoints/ep-1",
      ),
    );
    expect(savedBody(fetchMock)).toEqual({ agentId: "agent-1", enabled: true });
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
    expect(savedBody(fetchMock)).toEqual({ name: "Rovo" });

    fireEvent.click(screen.getByRole("button", { name: "I've copied it" }));
    expect(screen.queryByDisplayValue("pa2a_secret")).not.toBeInTheDocument();
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
  });
});
