import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  isAuthLoading: false,
  organizations: [] as { id: string; name: string }[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({
    user: { id: "u1" },
    isAuthLoading: state.isAuthLoading,
  }),
}));

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: () => ({
    data: { results: state.organizations },
    error: undefined,
    isLoading: false,
  }),
}));

import Home from "./page";

afterEach(() => {
  state.isAuthLoading = false;
  state.organizations = [];
});

// The page background flips with the theme, so the spinner must take a theme
// token for its colour rather than a fixed near-black.
function expectThemedSpinner() {
  const spinner = screen.getByRole("status", { name: "Loading" });
  expect(spinner).toHaveClass("text-muted-foreground");
  expect(spinner.outerHTML).not.toContain("gray-");
}

describe("Home", () => {
  it("shows a themed spinner while auth loads", () => {
    state.isAuthLoading = true;
    render(<Home />);
    expectThemedSpinner();
  });

  it("shows a themed spinner while redirecting to the first organization", () => {
    state.organizations = [{ id: "org1", name: "Acme" }];
    render(<Home />);
    expectThemedSpinner();
  });
});
