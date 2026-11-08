import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  authMock,
  swrMock,
  push,
  resetFormHarness,
  setDataFor,
  setError,
  setLoading,
  stubAcceptedSave,
  savedBody,
} from "@/test/form-test-harness";
import { selectOption } from "@/test/test-utils";
import { elsewhereClicked, GuardLink } from "@/test/unsaved-changes-harness";
import { UnsavedChangesProvider } from "./unsaved-changes-guard";

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("swr", () => swrMock);

import { WorkspaceWizard } from "./workspace-wizard";

function click(name: string) {
  return fireEvent.click(
    screen
      .getAllByRole("button", { name })
      // Every step stays mounted; only the visible step's button is clickable.
      .find((button) => !button.closest("[hidden], [data-state=inactive]"))!,
  );
}

// The Provider step has a Name field too; the Workspace's is first.
function workspaceName() {
  return screen.getAllByLabelText("Name")[0];
}

function renderWizard() {
  return render(
    <UnsavedChangesProvider>
      <WorkspaceWizard orgId="org1" />
      <GuardLink />
    </UnsavedChangesProvider>,
  );
}

function fillWorkspaceStep(name = "Research") {
  fireEvent.change(workspaceName(), { target: { value: name } });
  click("Next");
}

beforeEach(() => {
  resetFormHarness();
  elsewhereClicked.mockReset();
  setDataFor("/organizations/org1/providers", {
    results: [{ id: "shared-1", name: "Shared OpenAI" }],
  });
});

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
    fireEvent.mouseDown(screen.getByRole("tab", { name: "New provider" }));

    click("Next");

    expect(
      await screen.findByText("At least one model is required"),
    ).toBeInTheDocument();
    expect(screen.getByRole("listitem", { current: "step" })).toHaveTextContent(
      "Provider",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the Provider step on Shared provider when the org has some", () => {
    render(<WorkspaceWizard orgId="org1" />);
    fillWorkspaceStep();

    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "Shared provider",
    );
  });

  it("opens the Provider step on New provider when the org has none", () => {
    setDataFor("/organizations/org1/providers", { results: [] });
    render(<WorkspaceWizard orgId="org1" />);
    fillWorkspaceStep();

    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent(
      "New provider",
    );
  });

  // ADR-0008: an admin assigns the owner on creation; nothing is written until
  // the last step, which creates the Workspace with its Provider in one write.
  it("creates the workspace with the shared provider and owner picked, and opens it", async () => {
    setDataFor("/organizations/org1/members", {
      results: [{ userId: "u2", user: { name: "Bea", email: "bea@x.test" } }],
    });
    const fetchMock = stubAcceptedSave({ id: "ws9" });
    renderWizard();

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
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
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

  it("navigates freely before anything has been entered", () => {
    renderWizard();

    fireEvent.click(screen.getByText("Elsewhere"));

    expect(elsewhereClicked).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
  });

  it("holds a link click once something has been entered", () => {
    renderWizard();

    fireEvent.change(workspaceName(), { target: { value: "Research" } });
    fireEvent.click(screen.getByText("Elsewhere"));

    expect(elsewhereClicked).not.toHaveBeenCalled();
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
  });

  it("is clean again once a typed name is cleared", () => {
    renderWizard();

    fireEvent.change(workspaceName(), { target: { value: "Research" } });
    fireEvent.change(workspaceName(), { target: { value: "" } });
    fireEvent.click(screen.getByText("Elsewhere"));

    expect(elsewhereClicked).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
  });

  it("does not count re-picking the default owner as an edit", async () => {
    setDataFor("/organizations/org1/members", {
      results: [{ userId: "u2", user: { name: "Bea", email: "bea@x.test" } }],
    });
    renderWizard();

    await selectOption(" (you)", "(you)");
    fireEvent.click(screen.getByText("Elsewhere"));

    expect(elsewhereClicked).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("Discard unsaved changes?"),
    ).not.toBeInTheDocument();
  });

  it("holds a link click after moving to the next step", () => {
    renderWizard();
    fillWorkspaceStep();

    fireEvent.click(screen.getByText("Elsewhere"));

    expect(elsewhereClicked).not.toHaveBeenCalled();
    expect(screen.getByText("Discard unsaved changes?")).toBeInTheDocument();
  });
});

describe("WorkspaceWizard secondary reads", () => {
  const SHARED_PROVIDERS = "/organizations/org1/providers";
  const BACKENDS = "/organizations/org1/sandbox-backends";

  /** Walks the first two steps with the shared provider picked. */
  function reachSandboxStep() {
    fillWorkspaceStep();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Shared provider" }));
    fireEvent.click(screen.getByRole("switch", { name: "Shared OpenAI" }));
    click("Next");
  }

  it("doesn't claim there are no shared providers while the read is loading", () => {
    setLoading(SHARED_PROVIDERS);
    render(<WorkspaceWizard orgId="org1" />);
    fillWorkspaceStep();

    expect(screen.queryByText("No shared providers")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Loading shared providers"),
    ).toBeInTheDocument();
  });

  it("shows the shared providers read failure instead of claiming there are none", () => {
    setDataFor(SHARED_PROVIDERS, undefined);
    setError(new Error("500"), SHARED_PROVIDERS);
    render(<WorkspaceWizard orgId="org1" />);
    fillWorkspaceStep();

    expect(screen.getByText(/Failed to load providers/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("No shared providers")).not.toBeInTheDocument();
  });

  it("doesn't claim no sandbox backends are installed while the read is loading", () => {
    setLoading(BACKENDS);
    render(<WorkspaceWizard orgId="org1" />);
    reachSandboxStep();

    expect(
      screen.queryByText("No sandbox backends are installed on this server."),
    ).not.toBeInTheDocument();
  });

  it("shows the sandbox backends read failure instead of claiming none are installed", () => {
    setDataFor(BACKENDS, undefined);
    setError(new Error("500"), BACKENDS);
    render(<WorkspaceWizard orgId="org1" />);
    reachSandboxStep();

    expect(
      screen.getByText(/Failed to load sandbox backends/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.queryByText("No sandbox backends are installed on this server."),
    ).not.toBeInTheDocument();
  });
});
