import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  authMock,
  mockScopedSWR,
  mutate,
  navigationMock,
  renderList,
  resetListHarness,
  swrMock,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("next/navigation", () => ({
  ...navigationMock,
  useParams: () => ({ orgId: "org1" }),
}));
vi.mock("swr", () => swrMock);

import OrgMembersPage from "./page";

beforeEach(() => resetListHarness());

describe("OrgMembersPage", () => {
  it("says so when the organization has no members", () => {
    mockScopedSWR({ "/members": [] });
    renderList(<OrgMembersPage />);

    expect(screen.getByText("No members yet")).toBeInTheDocument();
  });

  it("shows a failed read as an error with a retry, not as no members", () => {
    mockScopedSWR({
      "/members": { error: { status: 500, message: "Server error" } },
    });
    renderList(<OrgMembersPage />);

    expect(
      screen.getByText("Failed to load members. Server error"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No members yet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });
});
