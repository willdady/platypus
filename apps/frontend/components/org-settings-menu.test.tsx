import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";

let pathname = "/org1/settings/members";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

import { OrgSettingsMenu } from "./org-settings-menu";

beforeEach(() => {
  pathname = "/org1/settings/members";
});

function renderMenu(organizationName?: string) {
  return render(
    <SidebarProvider>
      <OrgSettingsMenu orgId="org1" organizationName={organizationName} />
    </SidebarProvider>,
  );
}

function expectActive(label: string, active: boolean) {
  expect(screen.getByRole("link", { name: label })).toHaveAttribute(
    "data-active",
    String(active),
  );
}

describe("OrgSettingsMenu organization heading", () => {
  it("shows the organization name resolved by the layout", () => {
    renderMenu("Acme Corp");

    expect(
      screen.getByRole("heading", { name: "Acme Corp" }),
    ).toBeInTheDocument();
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
    renderMenu("Acme Corp");

    const separator = screen.getByRole("separator");
    const heading = screen.getByRole("heading", { name: "Acme Corp" });
    const generalLink = screen.getByRole("link", { name: "General" });
    expect(
      heading.compareDocumentPosition(separator) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      separator.compareDocumentPosition(generalLink) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("omits the heading without surfacing an error when the name is unavailable", () => {
    renderMenu(undefined);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Members" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plugins" })).toBeInTheDocument();
  });
});

describe("OrgSettingsMenu links", () => {
  it("lists the settings pages in order with their labels", () => {
    renderMenu();

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "General",
      "Members",
      "Invitations",
      "Providers",
      "MCP Servers",
      "Skills",
      "Agents",
      "Blueprints",
      "Plugins",
      "Inbound Triggers",
      "A2A endpoints",
    ]);
    for (const link of links) {
      expect(link).toContainHTML("<svg");
    }
  });

  it("links each item to its settings page", () => {
    renderMenu();

    expect(screen.getByRole("link", { name: "General" })).toHaveAttribute(
      "href",
      "/org1/settings",
    );
    expect(
      screen.getByRole("link", { name: "Inbound Triggers" }),
    ).toHaveAttribute("href", "/org1/settings/inbound-triggers");
    expect(screen.getByRole("link", { name: "A2A endpoints" })).toHaveAttribute(
      "href",
      "/org1/settings/a2a",
    );
  });

  it("highlights only General on its own exact path", () => {
    pathname = "/org1/settings";
    renderMenu();

    expectActive("General", true);
  });

  it("does not highlight General on another settings page", () => {
    renderMenu();

    expectActive("General", false);
    expectActive("Members", true);
  });

  it("highlights an item on paths beneath it", () => {
    pathname = "/org1/settings/mcp/server-1";
    renderMenu();

    expectActive("MCP Servers", true);
    expectActive("Members", false);
  });
});
