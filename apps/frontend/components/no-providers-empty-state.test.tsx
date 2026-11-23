import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { authMock, authState, resetSharedSpies } from "@/test/test-utils";

vi.mock("@/components/auth-provider", () => authMock);

import { NoProvidersEmptyState } from "./no-providers-empty-state";

beforeEach(resetSharedSpies);

function renderWorkspaceEmptyState(canManage?: boolean) {
  return render(
    <NoProvidersEmptyState
      orgId="org1"
      workspaceId="ws1"
      canManage={canManage}
    />,
  );
}

function addProviderButton() {
  return screen.queryByRole("link", { name: "Add provider" });
}

function adminHint() {
  return screen.queryByText(/Ask an organization admin to add one\./);
}

describe("NoProvidersEmptyState", () => {
  it("offers an Org Admin the Add provider button", () => {
    authState.actor = "org-admin";
    authState.workspaceDelegation = null;

    renderWorkspaceEmptyState();

    expect(addProviderButton()).toBeInTheDocument();
    expect(adminHint()).not.toBeInTheDocument();
  });

  it("offers a Workspace Owner with Provider self-management the Add provider button", () => {
    authState.actor = "workspace-owner";
    authState.workspaceDelegation = {
      providerSelfManagement: true,
      mcpSelfManagement: false,
    };

    renderWorkspaceEmptyState();

    expect(addProviderButton()).toBeInTheDocument();
    expect(adminHint()).not.toBeInTheDocument();
  });

  it("hides the Add provider button from a Workspace Owner without Provider self-management", () => {
    authState.actor = "workspace-owner";
    authState.workspaceDelegation = {
      providerSelfManagement: false,
      mcpSelfManagement: true,
    };

    renderWorkspaceEmptyState();

    expect(addProviderButton()).not.toBeInTheDocument();
    expect(adminHint()).toBeInTheDocument();
  });

  it("hides the Add provider button from a plain Org member and names who can add one", () => {
    authState.actor = "org-member";
    authState.workspaceDelegation = null;

    renderWorkspaceEmptyState();

    expect(addProviderButton()).not.toBeInTheDocument();
    expect(adminHint()).toBeInTheDocument();
  });

  it("lets an explicit canManage override the derived permission", () => {
    authState.actor = "org-admin";
    authState.workspaceDelegation = null;

    renderWorkspaceEmptyState(false);

    expect(addProviderButton()).not.toBeInTheDocument();
    expect(adminHint()).toBeInTheDocument();
  });

  it("lets an explicit canManage allow the button where the derived rule denies it", () => {
    authState.actor = "workspace-owner";
    authState.workspaceDelegation = {
      providerSelfManagement: false,
      mcpSelfManagement: false,
    };

    renderWorkspaceEmptyState(true);

    expect(addProviderButton()).toBeInTheDocument();
    expect(adminHint()).not.toBeInTheDocument();
  });

  it("offers no Workspace CTA outside a Workspace", () => {
    authState.actor = "org-admin";
    authState.workspaceDelegation = null;

    render(<NoProvidersEmptyState orgId="org1" />);

    expect(addProviderButton()).not.toBeInTheDocument();
    expect(adminHint()).not.toBeInTheDocument();
  });
});
