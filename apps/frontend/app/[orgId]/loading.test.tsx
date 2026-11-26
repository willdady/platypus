import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ pathname: "/org2" }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org2" }),
  usePathname: () => nav.pathname,
}));

vi.mock("@/components/header", () => ({
  Header: ({ leftContent }: { leftContent?: React.ReactNode }) => (
    <header>{leftContent}</header>
  ),
}));

vi.mock("@/components/back-button", () => ({
  BackButton: ({
    variant,
    fallbackHref,
  }: {
    variant?: string;
    fallbackHref?: string;
  }) => (
    <button
      aria-label="Back"
      data-variant={variant}
      data-fallback-href={fallbackHref}
    />
  ),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ actor: null, isAuthLoading: false }),
}));

vi.mock("swr", () => ({ preload: vi.fn(() => Promise.resolve()) }));

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: (entity: string) => ({
    data:
      entity === "organizations"
        ? {
            results: [
              { id: "org1", name: "Acme" },
              { id: "org2", name: "Globex" },
            ],
          }
        : { results: [{ id: "ws1", name: "Alpha", organizationId: "org2" }] },
    error: undefined,
    isLoading: false,
  }),
}));

import OrganizationLoading from "./loading";
import { resourcePageLayout } from "@/components/resource-page";

afterEach(() => {
  nav.pathname = "/org2";
});

describe("OrganizationLoading", () => {
  it("draws the Organization home from the cache, not placeholders", () => {
    render(<OrganizationLoading />);

    expect(screen.getByRole("link", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Globex" })).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("takes the wide wizard shape while Add Workspace loads", () => {
    nav.pathname = "/org2/create";
    render(<OrganizationLoading />);

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveClass(resourcePageLayout.wide.outer!);
    expect(screen.getByTestId("workspace-setup-body")).toHaveClass(
      resourcePageLayout.wide.inner,
    );
    expect(screen.getByTestId("workspace-setup")).toHaveClass(
      "h-dvh overflow-y-auto pb-4",
    );
    expect(screen.getAllByTestId("step-placeholder")).toHaveLength(3);
  });

  it("gives the settings skeleton the header Back the settings shell draws", () => {
    nav.pathname = "/org2/settings/agents/agent1";
    render(<OrganizationLoading />);

    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toHaveAttribute("data-variant", "header");
    expect(back).toHaveAttribute("data-fallback-href", "/org2/settings");
  });
});
