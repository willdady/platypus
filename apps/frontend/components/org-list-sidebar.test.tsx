import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";

const read = vi.hoisted(() => ({
  data: undefined as { results: { id: string; name: string }[] } | undefined,
  error: undefined as { status: number; message: string } | undefined,
  mutate: vi.fn(),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("swr", () => ({ preload: vi.fn(() => Promise.resolve()) }));

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: () => ({
    data: read.data,
    error: read.error,
    mutate: read.mutate,
  }),
}));

import { OrgListSidebar } from "./org-list-sidebar";

function renderSidebar() {
  return render(
    <SidebarProvider>
      <OrgListSidebar currentOrgId="org1" />
    </SidebarProvider>,
  );
}

beforeEach(() => {
  read.data = undefined;
  read.error = undefined;
  read.mutate.mockReset();
});

describe("OrgListSidebar", () => {
  it("announces both placeholders while the organizations load", () => {
    read.data = undefined;

    render(
      <SidebarProvider>
        <OrgListSidebar currentOrgId="org1" />
      </SidebarProvider>,
    );

    expect(
      screen.getByRole("status", { name: "Loading organizations" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Loading create organization" }),
    ).toBeInTheDocument();
  });

  it("offers Create organization below the list", () => {
    read.data = { results: [] };

    renderSidebar();

    expect(
      screen.getByRole("link", { name: "Create organization" }),
    ).toHaveAttribute("href", "/create");
  });

  it("lists organizations by name without reordering the cached results", () => {
    read.data = {
      results: [
        { id: "org2", name: "Globex" },
        { id: "org1", name: "Acme" },
      ],
    };

    renderSidebar();

    const names = screen
      .getAllByRole("link")
      .map((l) => l.textContent?.trim())
      .filter((name) => name === "Acme" || name === "Globex");
    expect(names).toEqual(["Acme", "Globex"]);
    expect(read.data.results.map((o) => o.name)).toEqual(["Globex", "Acme"]);
  });

  it("shows a failed read as a list error with a retry", () => {
    read.error = { status: 500, message: "Server error" };

    renderSidebar();

    expect(
      screen.getByText("Failed to load organizations. Server error"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(read.mutate).toHaveBeenCalledOnce();
  });
});
