import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import {
  authMock,
  mockScopedSWR,
  mutate,
  renderList,
  resetListHarness,
  swrMock,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { KanbanCardHistory } from "./kanban-card-history";

async function openHistory() {
  await renderList(
    <KanbanCardHistory
      orgId="org1"
      workspaceId="ws1"
      boardId="b1"
      cardId="c1"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "History" }));
}

beforeEach(() => resetListHarness());

describe("KanbanCardHistory", () => {
  it("shows skeleton rows, not a bare 'Loading…', while the history loads", async () => {
    mockScopedSWR({ "/history": { data: undefined } }, { strict: true });
    await openHistory();

    expect(
      screen.getByRole("status", { name: "Loading history" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  });

  it("says so when the card has no recorded changes", async () => {
    mockScopedSWR({ "/history": [] }, { strict: true });
    await openHistory();

    expect(screen.getByText("No changes recorded yet.")).toBeInTheDocument();
  });

  it("shows a failed read as an error with a retry, not as loading or empty", async () => {
    mockScopedSWR(
      {
        "/history": { error: { status: 500, message: "Server error" } },
      },
      { strict: true },
    );
    await openHistory();

    expect(
      screen.getByText("Failed to load history. Server error"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("status", { name: "Loading history" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No changes recorded yet."),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });
});
