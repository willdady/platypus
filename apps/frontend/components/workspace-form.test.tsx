import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  navigationMock,
  authMock,
  toastMock,
  swrMock,
  authState,
  resetFormHarness,
  setDataFor,
  setError,
  setLoading,
} from "@/lib/form-test-harness";

vi.mock("next/navigation", () => navigationMock);
vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { WorkspaceForm } from "./workspace-form";

const WORKSPACE_KEY = "/organizations/org1/workspaces/ws1";

const renderForm = () =>
  render(<WorkspaceForm orgId="org1" workspaceId="ws1" />);

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
