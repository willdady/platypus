import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  authState,
  navigationMock,
  push,
  refresh,
  toastSuccess,
  resetFormHarness,
  setDataFor,
  setError,
  setLoading,
  stubAcceptedSave,
  savedBody,
} from "@/lib/form-test-harness";
import { installResizeObserverStub, selectOption } from "@/lib/test-utils";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { WorkspaceForm } from "./workspace-form";

const WORKSPACE_KEY = "/organizations/org1/workspaces/ws1";

const renderForm = () =>
  render(<WorkspaceForm orgId="org1" workspaceId="ws1" />);

const RESEARCH = {
  id: "ws1",
  organizationId: "org1",
  ownerId: "u1",
  name: "Research",
  context: "",
};

const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WorkspaceForm record read", () => {
  beforeEach(() => resetFormHarness());

  it("shows the skeleton, not a blank editable form, while loading", () => {
    setLoading(WORKSPACE_KEY);
    renderForm();

    expect(screen.getByLabelText("Loading workspace")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("shows the failure notice on a cold server error", () => {
    setError({ status: 500 }, WORKSPACE_KEY);
    renderForm();

    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Back to workspace" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1");
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("seeds the fields from the loaded workspace", () => {
    setDataFor(WORKSPACE_KEY, {
      id: "ws1",
      organizationId: "org1",
      ownerId: "u1",
      name: "Research",
      context: "Be brief",
    });
    renderForm();

    expect(screen.getByLabelText("Name")).toHaveValue("Research");
    expect(screen.getByDisplayValue("Be brief")).toBeInTheDocument();
  });
});

describe("WorkspaceForm secondary reads", () => {
  beforeEach(() => resetFormHarness());

  it("holds the form back until the providers land, so the selects aren't blank", () => {
    setDataFor(WORKSPACE_KEY, {
      id: "ws1",
      organizationId: "org1",
      ownerId: "u1",
      name: "Research",
      context: "",
    });
    setLoading(`${WORKSPACE_KEY}/providers`);
    renderForm();

    expect(screen.getByLabelText("Loading workspace")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });
});

describe("WorkspaceForm create", () => {
  beforeEach(() => resetFormHarness());

  // The members read is gated on the actor, which is still resolving on a hard
  // refresh: without this the editable form showed, then the skeleton once the
  // admin check passed and the read began, then the form again.
  it("shows the skeleton while the membership resolves", () => {
    Object.assign(authState, { actor: "anonymous", isAuthLoading: true });
    render(<WorkspaceForm orgId="org1" />);

    expect(screen.getByLabelText("Loading workspace")).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
    Object.assign(authState, { isAuthLoading: false });
  });
});

describe("WorkspaceForm save", () => {
  beforeEach(() => resetFormHarness());

  // ADR-0008: an admin assigns the owner on creation.
  it("creates the workspace for the member the admin picked, and opens it", async () => {
    setDataFor("/organizations/org1/members", {
      results: [{ userId: "u2", user: { name: "Bea", email: "bea@x.test" } }],
    });
    const fetchMock = stubAcceptedSave({ id: "ws9" });
    render(<WorkspaceForm orgId="org1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Research" },
    });
    await selectOption(" (you)", "Bea");
    save();

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
    });
  });

  it("defaults the owner to the admin creating it", async () => {
    const fetchMock = stubAcceptedSave({ id: "ws9" });
    render(<WorkspaceForm orgId="org1" />);

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Research" },
    });
    save();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(savedBody(fetchMock).ownerId).toBe("u1");
  });

  it("sends the edited settings, with an unset provider as null, and refreshes", async () => {
    installResizeObserverStub();
    setDataFor(WORKSPACE_KEY, RESEARCH);
    const fetchMock = stubAcceptedSave(RESEARCH);
    renderForm();

    fireEvent.click(
      screen.getByRole("switch", { name: "Owner-managed providers" }),
    );
    save();

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Workspace updated"),
    );
    expect(refresh).toHaveBeenCalled();
    expect(savedBody(fetchMock)).toEqual({
      name: "Research",
      context: null,
      taskModelProviderId: null,
      memoryExtractionProviderId: null,
      memoryEmbeddingProviderId: null,
      maxDailySummaries: 90,
      providerSelfManagement: true,
      mcpSelfManagement: false,
    });
  });

  // ADR-0006: delegation is the org admin's to grant, not the owner's.
  it("hides the delegation switches from a workspace owner", () => {
    authState.actor = "workspace-owner";
    setDataFor(WORKSPACE_KEY, RESEARCH);
    renderForm();

    expect(screen.getByLabelText("Name")).toHaveValue("Research");
    expect(
      screen.queryByRole("switch", { name: "Owner-managed providers" }),
    ).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Owner-managed MCP servers" }),
    ).toBeNull();
  });
});
