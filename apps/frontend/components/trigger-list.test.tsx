import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { Trigger } from "@platypus/schemas";
import {
  authMock,
  toastMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
  toastError,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { TriggerList } from "./trigger-list";

// --- Fixtures ----------------------------------------------------------------

const cronTrigger: Trigger = {
  id: "t1",
  name: "Nightly job",
  type: "cron",
  enabled: true,
  agentId: "agent1",
  config: { cronExpression: "0 0 * * *", timezone: "UTC" },
} as unknown as Trigger;

function renderTriggers(triggers: Trigger[], menuItem?: string) {
  mockScopedSWR({ "/triggers": triggers });
  return renderList(<TriggerList orgId="org1" workspaceId="ws1" />, menuItem);
}

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("TriggerList delete", () => {
  it("deletes through the request module and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    renderTriggers([cronTrigger], "Delete");
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/triggers/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    stubRejectedSave("Trigger is in use", 409);

    renderTriggers([cronTrigger], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(screen.getByText("Trigger is in use")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    // The dialog stays open on a refused delete, letting the user retry.
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});

describe("TriggerList toggle enabled", () => {
  it("PUTs the flipped enabled flag and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    renderTriggers([cronTrigger], "Disable");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/workspaces/ws1/triggers/t1",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it("surfaces the backend's reason and does not flip when the toggle is refused", async () => {
    stubRejectedSave("Trigger is running", 409);

    renderTriggers([cronTrigger], "Disable");

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Trigger is running"),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("TriggerList list states", () => {
  // The page around it owns the empty copy, so the list renders nothing at all
  // rather than a second, competing empty state.
  it("renders nothing when the workspace has no triggers", () => {
    const { container } = renderTriggers([]);

    expect(container).toBeEmptyDOMElement();
  });

  it("surfaces a failed read rather than rendering an empty list", () => {
    mockScopedSWR({ "/triggers": { error: new Error("500") } });
    renderList(<TriggerList orgId="org1" workspaceId="ws1" />);

    expect(screen.getByText(/Failed to load triggers/)).toBeInTheDocument();
  });
});
