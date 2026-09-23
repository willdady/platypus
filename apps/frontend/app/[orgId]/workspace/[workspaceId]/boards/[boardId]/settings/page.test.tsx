import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
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
  savedBody,
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
});
