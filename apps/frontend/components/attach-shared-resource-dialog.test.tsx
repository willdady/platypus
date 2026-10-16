import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
} from "@/test/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { AttachSharedResourceDialog } from "./attach-shared-resource-dialog";

// --- Helpers -----------------------------------------------------------------

function renderDialog(attachedIds: string[] = []) {
  return renderList(
    <AttachSharedResourceDialog
      open={true}
      onOpenChange={() => {}}
      orgId="org1"
      workspaceId="ws1"
      resourceType="skill"
      attachedIds={attachedIds}
      onAttached={() => {}}
    />,
  );
}

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe("AttachSharedResourceDialog", () => {
  it("shows a placeholder, not a false empty, while the list loads", async () => {
    mockScopedSWR({ "/skills": { isLoading: true } }, { strict: true });
    await renderDialog();

    expect(screen.getByLabelText("Loading shared skills")).toBeInTheDocument();
    expect(
      screen.queryByText("No shared skills available to attach."),
    ).not.toBeInTheDocument();
  });

  it("says none are available once loaded with nothing unattached", async () => {
    mockScopedSWR(
      { "/skills": [{ id: "s1", name: "Research" }] },
      { strict: true },
    );
    await renderDialog(["s1"]);

    expect(
      screen.getByText("No shared skills available to attach."),
    ).toBeInTheDocument();
  });

  it("lists the unattached resources once loaded", async () => {
    mockScopedSWR(
      { "/skills": [{ id: "s1", name: "Research" }] },
      { strict: true },
    );
    await renderDialog();

    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach" })).toBeInTheDocument();
  });
});
