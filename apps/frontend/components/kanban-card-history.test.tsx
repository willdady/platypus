import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  authMock,
  mockScopedSWR,
  mutate,
  renderList,
  resetListHarness,
  swrMock,
} from "@/lib/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { KanbanCardHistory } from "./kanban-card-history";

const openHistory = () => {
  renderList(
    <KanbanCardHistory
      orgId="org1"
      workspaceId="ws1"
      boardId="b1"
      cardId="c1"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "History" }));
};

beforeEach(() => resetListHarness());

describe("KanbanCardHistory", () => {
  it("says so when the card has no recorded changes", () => {
    mockScopedSWR({ "/history": [] });
    openHistory();

    expect(screen.getByText("No changes recorded yet.")).toBeInTheDocument();
  });

  it("shows a failed read as an error with a retry, not as loading or empty", () => {
    mockScopedSWR({
      "/history": { error: { status: 500, message: "Server error" } },
    });
    openHistory();

    expect(
      screen.getByText("Failed to load history. Server error"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByText("No changes recorded yet.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });
});
