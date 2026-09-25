import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  authState,
  navigationMock,
  refresh,
  toastSuccess,
  resetFormHarness,
  setDataFor,
  setError,
  setLoading,
  stubAcceptedSave,
  savedBody,
} from "@/lib/form-test-harness";
import { installResizeObserverStub } from "@/lib/test-utils";

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

describe("WorkspaceForm save", () => {
  beforeEach(() => resetFormHarness());

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
