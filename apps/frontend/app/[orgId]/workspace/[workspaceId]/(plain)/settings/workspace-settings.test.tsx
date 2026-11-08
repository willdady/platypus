import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The form is its own component with its own tests; this screen only places it.
vi.mock("@/components/workspace-form", () => ({
  WorkspaceForm: () => <div data-testid="workspace-form" />,
}));

import WorkspaceSettingsPage from "./workspace-settings";

describe("Workspace settings", () => {
  it("shows the Organization and Workspace IDs, each with a copy button", () => {
    render(<WorkspaceSettingsPage orgId="org_123" workspaceId="ws_456" />);

    expect(screen.getByLabelText("Organization ID")).toHaveValue("org_123");
    expect(
      screen.getByRole("button", { name: "Copy organization id" }),
    ).toBeInTheDocument();

    expect(screen.getByLabelText("Workspace ID")).toHaveValue("ws_456");
    expect(
      screen.getByRole("button", { name: "Copy workspace id" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("workspace-form")).toBeInTheDocument();
  });
});
