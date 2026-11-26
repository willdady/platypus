import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import {
  authMock,
  mockScopedSWR,
  mutate,
  resetListHarness,
  swrMock,
} from "@/test/list-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import BoardsPage from "./boards-page";

async function renderPage() {
  // why: use() suspends on the params Promise, so the render must settle in an async act
  function mountPage() {
    render(
      <Suspense>
        <BoardsPage
          params={Promise.resolve({ orgId: "org1", workspaceId: "ws1" })}
        />
      </Suspense>,
    );
  }
  await act(async () => {
    mountPage();
  });
}

beforeEach(() => {
  resetListHarness();
  localStorage.clear();
});

describe("Boards screen", () => {
  it("is titled Boards and links each Board to its page", async () => {
    mockScopedSWR(
      {
        "/providers": [{ id: "p1", name: "OpenAI" }],
        "/boards": [{ id: "b1", name: "Sprint planning" }],
      },
      { strict: true },
    );
    await renderPage();

    expect(screen.getByRole("heading", { name: "Boards" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Sprint planning/ }),
    ).toHaveAttribute("href", "/org1/workspace/ws1/boards/b1");
  });

  it("offers Create board", async () => {
    mockScopedSWR(
      { "/providers": [{ id: "p1", name: "OpenAI" }], "/boards": [] },
      { strict: true },
    );
    await renderPage();

    expect(screen.getByRole("link", { name: "Create board" })).toHaveAttribute(
      "href",
      "/org1/workspace/ws1/boards/create",
    );
  });

  it("says there are no Boards yet", async () => {
    mockScopedSWR(
      { "/providers": [{ id: "p1", name: "OpenAI" }], "/boards": [] },
      { strict: true },
    );
    await renderPage();

    expect(screen.getByText("No boards yet")).toBeInTheDocument();
  });

  it("asks for a Provider, and offers no Create board, when the Workspace has none", async () => {
    mockScopedSWR({ "/providers": [], "/boards": [] }, { strict: true });
    await renderPage();

    expect(screen.getByText("No providers configured")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Create board" }),
    ).not.toBeInTheDocument();
  });

  it("shows a failed read as an error with a retry, not as no Boards", async () => {
    mockScopedSWR(
      {
        "/providers": [{ id: "p1", name: "OpenAI" }],
        "/boards": { error: { status: 500, message: "Server error" } },
      },
      { strict: true },
    );
    await renderPage();

    expect(
      screen.getByText("Failed to load boards. Server error"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No boards yet")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mutate).toHaveBeenCalled();
  });
});
