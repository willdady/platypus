import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import {
  authMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { ContextsList } from "./contexts-list";

beforeEach(resetListHarness);

// --- Tests -------------------------------------------------------------------

describe("ContextsList", () => {
  it("shows placeholder rows, not the empty state, while loading", () => {
    mockScopedSWR({ "/contexts": { isLoading: true } });
    renderList(<ContextsList />);

    expect(
      screen.getByLabelText("Loading workspace contexts"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No workspace contexts."),
    ).not.toBeInTheDocument();
  });

  it("shows the failure and its reason when the read fails", () => {
    mockScopedSWR({
      "/contexts": { error: { message: "x", info: { message: "Boom" } } },
    });
    renderList(<ContextsList />);

    expect(
      screen.getByText("Failed to load workspace contexts. Boom"),
    ).toBeInTheDocument();
  });

  it("lists workspace contexts once loaded", () => {
    mockScopedSWR({
      "/contexts": [
        { id: "g", workspaceId: null, content: "global" },
        {
          id: "c1",
          workspaceId: "ws1",
          workspaceName: "Engineering",
          organizationName: "Acme",
          content: "x",
        },
      ],
    });
    renderList(<ContextsList />);

    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });
});
