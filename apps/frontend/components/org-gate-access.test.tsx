import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  stubAcceptedSave,
  mutate,
} from "@/lib/list-test-harness";
import { selectOption } from "@/lib/test-utils";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { OrgA2aAccess, OrgInboundTriggerAccess } from "./org-gate-access";

const workspace = (over: Record<string, unknown> = {}) => ({
  id: "ws-1",
  name: "Support",
  ownerName: "Dana Owner",
  allowed: false,
  count: 0,
  ...over,
});

const access = (over: Record<string, unknown> = {}) => ({
  data: {
    gate: "all",
    workspaces: [
      workspace({ count: 2 }),
      workspace({ id: "ws-2", name: "Billing" }),
    ],
    ...over,
  },
});

const sentBody = (fetchMock: ReturnType<typeof stubAcceptedSave>) =>
  JSON.parse(fetchMock.mock.calls[0][1].body as string);

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrgInboundTriggerAccess", () => {
  it("lists no workspaces unless Selected workspaces is chosen", () => {
    mockScopedSWR({ "/inbound-triggers/access": access() });
    renderList(<OrgInboundTriggerAccess orgId="org1" />);

    expect(screen.getByRole("combobox")).toHaveTextContent("All workspaces");
    expect(screen.queryByText("Allowed workspaces")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows each workspace's switch under Selected workspaces", () => {
    mockScopedSWR({
      "/inbound-triggers/access": access({
        gate: "selected",
        workspaces: [workspace({ allowed: true })],
      }),
    });
    renderList(<OrgInboundTriggerAccess orgId="org1" />);

    expect(screen.getByText("Allowed workspaces")).toBeInTheDocument();
    expect(screen.getByText("Dana Owner")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Allow Support" })).toBeChecked();
  });

  it("warns about a workspace with Inbound Triggers that would be cut off, then saves the gate and switches in one call", async () => {
    const fetchMock = stubAcceptedSave(access().data);
    mockScopedSWR({ "/inbound-triggers/access": access() });
    renderList(<OrgInboundTriggerAccess orgId="org1" />);

    await selectOption("All workspaces", "Selected workspaces");
    expect(
      screen.getByText(/Support has Inbound Triggers but isn't allowed/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Allow Support" }));
    expect(
      screen.queryByText(/has Inbound Triggers but isn't allowed/),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/inbound-triggers/access",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(sentBody(fetchMock)).toEqual({
      gate: "selected",
      allowedWorkspaceIds: ["ws-1"],
    });
  });

  it("leaves the switches alone when saving another setting", async () => {
    const fetchMock = stubAcceptedSave(access().data);
    mockScopedSWR({ "/inbound-triggers/access": access() });
    renderList(<OrgInboundTriggerAccess orgId="org1" />);

    await selectOption("All workspaces", "No workspaces");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(sentBody(fetchMock)).toEqual({ gate: "off" });
  });
});

describe("OrgA2aAccess", () => {
  const a2aAccess = {
    gate: "off",
    workspaces: [
      {
        id: "ws-1",
        name: "Support",
        ownerName: "Dana Owner",
        allowed: false,
        count: 1,
      },
    ],
  };

  it("is off, then saves the A2A gate, warning about endpoints it would cut off", async () => {
    const fetchMock = stubAcceptedSave(a2aAccess);
    mockScopedSWR({ "/a2a/access": { data: a2aAccess } });
    renderList(<OrgA2aAccess orgId="org1" />);

    expect(screen.getByRole("combobox")).toHaveTextContent("No workspaces");

    await selectOption("No workspaces", "Selected workspaces");
    expect(
      screen.getByText(/Support has A2A endpoints but isn't allowed/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Allow Support" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/a2a/access",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(sentBody(fetchMock)).toEqual({
      gate: "selected",
      allowedWorkspaceIds: ["ws-1"],
    });
  });
});
