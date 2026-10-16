import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";

// --- Module mocks ------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => "/org1/settings/members",
}));

import { OrgSettingsMenu } from "./org-settings-menu";

function renderMenu(organizationName?: string) {
  return render(
    <SidebarProvider>
      <OrgSettingsMenu orgId="org1" organizationName={organizationName} />
    </SidebarProvider>,
  );
}

// --- Tests -------------------------------------------------------------------

describe("OrgSettingsMenu organization heading", () => {
  it("shows the organization name resolved by the layout", () => {
    renderMenu("Acme Corp");

    expect(
      screen.getByRole("heading", { name: "Acme Corp" }),
    ).toBeInTheDocument();
    // Never the org ID in place of the name
    expect(screen.queryByText("org1")).not.toBeInTheDocument();
  });

  it("keeps a long name truncated and exposed in full", () => {
    const name = "A Very Long Organization Name That Overflows";
    renderMenu(name);

    const heading = screen.getByRole("heading", { name });
    expect(heading).toHaveClass("truncate");
    expect(heading).toHaveAttribute("title", name);
  });

  it("separates the heading from the links with a rule", () => {
    const { container } = renderMenu("Acme Corp");

    const separator = container.querySelector(
      '[data-slot="sidebar-separator"]',
    );
    expect(separator).toBeInTheDocument();

    // Sits between the heading and the first link
    const heading = screen.getByRole("heading", { name: "Acme Corp" });
    const generalLink = screen.getByRole("link", { name: "General" });
    expect(
      heading.compareDocumentPosition(separator!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      separator!.compareDocumentPosition(generalLink) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("omits the heading without surfacing an error when the name is unavailable", () => {
    const { container } = renderMenu(undefined);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    // No stray rule with nothing above it
    expect(
      container.querySelector('[data-slot="sidebar-separator"]'),
    ).toBeNull();
    expect(container.textContent).not.toMatch(/error/i);
    // The settings pages stay fully navigable
    expect(screen.getByRole("link", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plugins" })).toBeInTheDocument();
  });
});
