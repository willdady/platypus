import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { installMatchMediaStub } from "@/lib/test-utils";

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgId: "org2" }),
  usePathname: () => "/org2",
}));

vi.mock("@/components/header", () => ({
  Header: ({ leftContent }: { leftContent?: React.ReactNode }) => (
    <header>{leftContent}</header>
  ),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ actor: null, isAuthLoading: false }),
}));

vi.mock("swr", () => ({ preload: vi.fn() }));

// Everything the Organization home reads is already in the client cache, as
// it is on a switch from another Organization.
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

beforeAll(installMatchMediaStub);

describe("OrganizationLoading", () => {
  it("draws the Organization home from the cache, not placeholders", () => {
    const { container } = render(<OrganizationLoading />);

    expect(screen.getByRole("link", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Globex" })).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
