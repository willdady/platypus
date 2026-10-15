import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { installMatchMediaStub } from "@/lib/test-utils";

const read = vi.hoisted(() => ({
  data: undefined as { results: { id: string; name: string }[] } | undefined,
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("swr", () => ({ preload: vi.fn() }));

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: () => ({ data: read.data, error: undefined }),
}));

import { OrgListSidebar } from "./org-list-sidebar";

beforeAll(installMatchMediaStub);

describe("OrgListSidebar", () => {
  it("lists organizations by name without reordering the cached results", () => {
    read.data = {
      results: [
        { id: "org2", name: "Globex" },
        { id: "org1", name: "Acme" },
      ],
    };

    render(
      <SidebarProvider>
        <OrgListSidebar currentOrgId="org1" />
      </SidebarProvider>,
    );

    const names = screen
      .getAllByRole("link")
      .map((l) => l.textContent?.trim())
      .filter((name) => name === "Acme" || name === "Globex");
    expect(names).toEqual(["Acme", "Globex"]);
    expect(read.data.results.map((o) => o.name)).toEqual(["Globex", "Acme"]);
  });
});
