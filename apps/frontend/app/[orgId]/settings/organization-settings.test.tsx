import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The form is its own component with its own tests; this screen only places it.
vi.mock("@/components/organization-form", () => ({
  OrganizationForm: () => <div data-testid="organization-form" />,
}));

import OrgSettingsPage from "./organization-settings";

describe("Organization settings", () => {
  it("shows the Organization ID with a copy button", () => {
    render(<OrgSettingsPage orgId="org_123" />);

    expect(screen.getByLabelText("Organization ID")).toHaveValue("org_123");
    expect(
      screen.getByRole("button", { name: "Copy organization id" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("organization-form")).toBeInTheDocument();
  });
});
