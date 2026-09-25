import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  configuredMutate,
  resetFormHarness,
  setDataFor,
  setError,
  stubAcceptedSave,
  stubRejectedSave,
  savedBody,
  push,
  toastError,
} from "@/lib/form-test-harness";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);
vi.mock("@/components/back-button", () => ({ BackButton: () => null }));

import BoardSettingsPage from "./page";

const BOARD = "http://test/organizations/org1/workspaces/ws1/boards/b1";

const renderPage = async () => {
  // `params` is unwrapped with `use`, so the first render suspends.
  await act(async () => {
    render(
      <Suspense>
        <BoardSettingsPage
          params={Promise.resolve({
            orgId: "org1",
            workspaceId: "ws1",
            boardId: "b1",
          })}
        />
      </Suspense>,
    );
  });
};

describe("BoardSettingsPage", () => {
  beforeEach(() => resetFormHarness());
  afterEach(() => vi.unstubAllGlobals());

  it("shows the failure notice when the board can't be read", async () => {
    setError({ status: 500 }, "/boards/b1");
    await renderPage();

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("saves the board and revalidates the board view's state", async () => {
    setDataFor("/boards/b1", {
      id: "b1",
      name: "Roadmap",
      description: null,
      labels: [{ id: "l1", name: "Bug", color: "#ef4444" }],
    });
    const fetchMock = stubAcceptedSave({ id: "b1" });
    await renderPage();

    expect(screen.getByLabelText("Name")).toHaveValue("Roadmap");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Roadmap 2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(BOARD);
    expect(savedBody(fetchMock)).toEqual({
      name: "Roadmap 2",
      description: null,
      labels: [{ id: "l1", name: "Bug", color: "#ef4444" }],
    });
    await waitFor(() =>
      expect(configuredMutate).toHaveBeenCalledWith(`${BOARD}/state`),
    );
  });

  describe("deleting", () => {
    const confirmDelete = () => {
      fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
      const dialog = screen.getByRole("dialog");
      fireEvent.change(
        within(dialog).getByPlaceholderText("Type 'delete board' to confirm"),
        { target: { value: "delete board" } },
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    };

    it("deletes it and returns to the workspace", async () => {
      setDataFor("/boards/b1", {
        id: "b1",
        name: "Roadmap",
        description: null,
        labels: [],
      });
      const fetchMock = stubAcceptedSave();
      await renderPage();

      confirmDelete();

      await waitFor(() =>
        expect(push).toHaveBeenCalledWith("/org1/workspace/ws1"),
      );
      expect(fetchMock).toHaveBeenCalledWith(
        BOARD,
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("reports a refused delete and stays on the page", async () => {
      setDataFor("/boards/b1", {
        id: "b1",
        name: "Roadmap",
        description: null,
        labels: [],
      });
      stubRejectedSave("Not allowed", 403);
      await renderPage();

      confirmDelete();

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Not allowed"),
      );
      expect(push).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
    });
  });
});
