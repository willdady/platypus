import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { ManageAttachmentsDialog } from "./manage-sharing";

// --- Helpers -----------------------------------------------------------------

/**
 * Registers the two reads the dialog makes — the attachments it already has,
 * and the workspaces it can attach to. `/attachments?` goes first: matching is
 * by URL fragment in registration order, and the attachments URL also carries
 * the org path the workspaces read is keyed on.
 */
function renderDialog({
  attached = [],
  workspaces = [],
}: {
  attached?: { workspaceId: string; workspaceName: string }[];
  workspaces?: { id: string; name: string }[];
}) {
  mockScopedSWR({ "/attachments?": attached, "/workspaces": workspaces });
  return renderList(
    <ManageAttachmentsDialog
      orgId="org1"
      resourceType="agent"
      resourceId="a1"
      resourceName="Support Bot"
      open={true}
      onOpenChange={() => {}}
    />,
  );
}

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("ManageAttachmentsDialog attach", () => {
  it("POSTs the attachment and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    renderDialog({ workspaces: [{ id: "ws1", name: "Engineering" }] });
    fireEvent.click(screen.getByText("Engineering"));

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/attachments",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          resourceType: "agent",
          resourceId: "a1",
          workspaceId: "ws1",
        }),
      }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when attach is refused", async () => {
    stubRejectedSave("Already attached", 409);

    renderDialog({ workspaces: [{ id: "ws1", name: "Engineering" }] });
    fireEvent.click(screen.getByText("Engineering"));

    await waitFor(() =>
      expect(screen.getByText("Already attached")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("ManageAttachmentsDialog detach", () => {
  it("surfaces the backend's reason inline and does not revalidate when detach is refused", async () => {
    stubRejectedSave("Locked elsewhere", 403);

    renderDialog({
      attached: [{ workspaceId: "ws1", workspaceName: "Engineering" }],
    });
    fireEvent.click(screen.getByLabelText("Detach Engineering"));

    await waitFor(() =>
      expect(screen.getByText("Locked elsewhere")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    // The chip stays — no optimistic removal on a refused detach.
    expect(screen.getByText("Engineering")).toBeInTheDocument();
  });
});
