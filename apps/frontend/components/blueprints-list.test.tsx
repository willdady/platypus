import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { Blueprint } from "@platypus/schemas";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
  toastInfo,
  menuItemLabels,
} from "@/test/list-test-harness";
import { openDropdownMenu } from "@/test/test-utils";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { BlueprintsList } from "./blueprints-list";

// --- Fixtures ----------------------------------------------------------------

const blueprint: Blueprint = {
  id: "b1",
  name: "Starter",
  description: "Starter workspace",
  items: [],
} as unknown as Blueprint;

function renderBlueprints(blueprints: Blueprint[], menuItem?: string) {
  mockScopedSWR({ "/blueprints": blueprints }, { strict: true });
  return renderList(<BlueprintsList orgId="org1" />, menuItem);
}

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe("BlueprintsList menu", () => {
  it("puts Edit before Apply to workspace", async () => {
    await renderBlueprints([blueprint]);
    await openDropdownMenu();

    expect(menuItemLabels()).toEqual(["Edit", "Apply to workspace", "Delete"]);
  });
});

describe("BlueprintsList delete", () => {
  it("deletes through the request module and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    await renderBlueprints([blueprint], "Delete");
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/blueprints/b1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    stubRejectedSave("Blueprint is in use", 409);

    await renderBlueprints([blueprint], "Delete");
    await confirmDialog("Delete");

    expect(await screen.findByText("Blueprint is in use")).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("surfaces a forbidden refusal inline like any other failure", async () => {
    stubRejectedSave("You do not have permission to delete blueprints", 403);

    await renderBlueprints([blueprint], "Delete");
    await confirmDialog("Delete");

    expect(
      await screen.findByText(
        "You do not have permission to delete blueprints",
      ),
    ).toBeInTheDocument();
    expect(toastInfo).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("BlueprintsList empty state", () => {
  it("shows the empty state when the organization has no blueprints", async () => {
    await renderBlueprints([]);

    expect(screen.getByText(/No blueprints yet/i)).toBeInTheDocument();
  });
});
