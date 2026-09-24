import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { Blueprint } from "@platypus/schemas";
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
  toastInfo,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
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
  mockScopedSWR({ "/blueprints": blueprints });
  return renderList(<BlueprintsList orgId="org1" />, menuItem);
}

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("BlueprintsList delete", () => {
  it("deletes through the request module and revalidates on success", async () => {
    const fetchMock = stubAcceptedSave();

    renderBlueprints([blueprint], "Delete");
    await confirmDialog("Delete");

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/organizations/org1/blueprints/b1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    stubRejectedSave("Blueprint is in use", 409);

    renderBlueprints([blueprint], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(screen.getByText("Blueprint is in use")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("surfaces a forbidden refusal inline like any other failure", async () => {
    stubRejectedSave("You do not have permission to delete blueprints", 403);

    renderBlueprints([blueprint], "Delete");
    await confirmDialog("Delete");

    await waitFor(() =>
      expect(
        screen.getByText("You do not have permission to delete blueprints"),
      ).toBeInTheDocument(),
    );
    expect(toastInfo).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("BlueprintsList list states", () => {
  it("shows the empty state when the organization has no blueprints", () => {
    renderBlueprints([]);

    expect(screen.getByText(/No blueprints yet/i)).toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", () => {
    mockScopedSWR({ "/blueprints": { error: new Error("500") } });
    renderList(<BlueprintsList orgId="org1" />);

    expect(screen.getByText(/Failed to load blueprints/)).toBeInTheDocument();
  });

  it("holds the grid with a skeleton, not the empty state, while loading", () => {
    mockScopedSWR({ "/blueprints": { isLoading: true } });
    renderList(<BlueprintsList orgId="org1" />);

    expect(
      screen.getByRole("status", { name: "Loading blueprints" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/No blueprints yet/i)).not.toBeInTheDocument();
  });
});
