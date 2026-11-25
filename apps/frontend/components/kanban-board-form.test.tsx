import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  authMock,
  swrMock,
  push,
  resetFormHarness,
  setDataFor,
  stubAcceptedSave,
  stubRejectedSave,
  toastSuccess,
} from "@/test/form-test-harness";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { KanbanBoardForm } from "./kanban-board-form";

beforeEach(() => resetFormHarness());

describe("KanbanBoardForm success feedback", () => {
  it("toasts that the board was created", async () => {
    stubAcceptedSave({ id: "b1", name: "Roadmap", labels: [] });
    render(<KanbanBoardForm orgId="org1" workspaceId="ws1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Roadmap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Board created"),
    );
    expect(push).toHaveBeenCalledWith("/org1/workspace/ws1/boards/b1");
  });

  it("toasts that the board was updated and stays on the settings page", async () => {
    setDataFor("/boards/b1", {
      id: "b1",
      name: "Roadmap",
      description: "",
      labels: [],
    });
    stubAcceptedSave({ id: "b1", name: "Roadmap", labels: [] });

    render(<KanbanBoardForm orgId="org1" workspaceId="ws1" boardId="b1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Board updated"),
    );
    expect(push).not.toHaveBeenCalled();
  });
});

describe("KanbanBoardForm label errors", () => {
  it("shows a rejected labels write and clears it on the next label edit", async () => {
    setDataFor("/boards/b1", {
      id: "b1",
      name: "Roadmap",
      description: "",
      labels: [{ id: "l1", name: "Bug", color: "#ef4444" }],
    });
    stubRejectedSave([
      { path: ["labels"], message: "A label name must be unique" },
    ]);

    render(<KanbanBoardForm orgId="org1" workspaceId="ws1" boardId="b1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Save" }));

    expect(
      await screen.findByText("A label name must be unique"),
    ).toBeInTheDocument();

    const labelName = screen.getByPlaceholderText("Label name");
    fireEvent.change(labelName, { target: { value: "Bugfix" } });

    await waitFor(() =>
      expect(
        screen.queryByText("A label name must be unique"),
      ).not.toBeInTheDocument(),
    );
  });
});
