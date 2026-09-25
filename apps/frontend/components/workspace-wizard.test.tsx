import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  navigationMock,
  push,
  resetFormHarness,
  setDataFor,
  stubAcceptedSave,
  savedBody,
} from "@/lib/form-test-harness";
import { selectOption } from "@/lib/test-utils";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { WorkspaceWizard } from "./workspace-wizard";

const click = (name: string) =>
  fireEvent.click(
    screen
      .getAllByRole("button", { name })
      // Every step stays mounted; only the visible step's button is clickable.
      .find((button) => !button.closest("[hidden], [data-state=inactive]"))!,
  );

// The Provider step has a Name field too; the Workspace's is first.
const workspaceName = () => screen.getAllByLabelText("Name")[0];

const fillWorkspaceStep = (name = "Research") => {
  fireEvent.change(workspaceName(), { target: { value: name } });
  click("Next");
};

beforeEach(() => {
  resetFormHarness();
  setDataFor("/organizations/org1/providers", {
    results: [{ id: "shared-1", name: "Shared OpenAI" }],
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("WorkspaceWizard", () => {
  it("stays on the first step until the workspace has a valid name", () => {
    render(<WorkspaceWizard orgId="org1" />);

    click("Next");

    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent(
      "Workspace",
    );
  });

  it("does not move past a new provider the schema rejects, and writes nothing", async () => {
    const fetchMock = stubAcceptedSave({ id: "ws9" });
    render(<WorkspaceWizard orgId="org1" />);
    fillWorkspaceStep();

    click("Next");

    expect(
      await screen.findByText("At least one model is required"),
    ).toBeInTheDocument();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent(
      "Provider",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ADR-0008: an admin assigns the owner on creation; nothing is written until
  // the last step, which creates the Workspace with its Provider in one write.
  it("creates the workspace with the shared provider and owner picked, and opens it", async () => {
    setDataFor("/organizations/org1/members", {
      results: [{ userId: "u2", user: { name: "Bea", email: "bea@x.test" } }],
    });
    const fetchMock = stubAcceptedSave({ id: "ws9" });
    render(<WorkspaceWizard orgId="org1" />);

    fireEvent.change(workspaceName(), {
      target: { value: "Research" },
    });
    await selectOption(" (you)", "Bea");
    click("Next");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Shared provider" }));
    fireEvent.click(screen.getByRole("switch", { name: "Shared OpenAI" }));
    click("Next");
    expect(fetchMock).not.toHaveBeenCalled();

    click("Save");

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/org1/workspace/ws9"),
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://test/organizations/org1/workspaces",
    );
    expect(savedBody(fetchMock)).toEqual({
      name: "Research",
      context: null,
      ownerId: "u2",
      sharedProviderIds: ["shared-1"],
    });
  });

  it("creates the sandbox with the workspace when one is configured", async () => {
    setDataFor("/organizations/org1/sandbox-backends", {
      results: [{ backend: "docker", name: "Docker" }],
    });
    const fetchMock = stubAcceptedSave({ id: "ws9" });
    render(<WorkspaceWizard orgId="org1" />);
    fillWorkspaceStep();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Shared provider" }));
    fireEvent.click(screen.getByRole("switch", { name: "Shared OpenAI" }));
    click("Next");

    fireEvent.click(
      screen.getByRole("switch", { name: "Configure a sandbox" }),
    );
    fireEvent.change(screen.getAllByLabelText("Name").at(-1)!, {
      target: { value: "Dev box" },
    });
    click("Save");

    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/org1/workspace/ws9"),
    );
    expect(savedBody(fetchMock).sandbox).toMatchObject({
      name: "Dev box",
      backend: "docker",
    });
  });

  it("keeps what was entered when going back", () => {
    render(<WorkspaceWizard orgId="org1" />);
    fillWorkspaceStep("Research");

    click("Back");

    expect(workspaceName()).toHaveValue("Research");
  });
});
