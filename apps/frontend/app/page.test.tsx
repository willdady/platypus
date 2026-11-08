import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  isAuthLoading: false,
  organizations: [] as { id: string; name: string }[],
  error: undefined as { status: number; message: string } | undefined,
  mutate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({
    user: { id: "u1" },
    isAuthLoading: state.isAuthLoading,
  }),
  useAuthClient: () => ({}),
}));

vi.mock("@/hooks/use-scoped-swr", () => ({
  useScopedSWR: () => ({
    // A failed read has no data; the page must not read it as an empty list.
    data: state.error ? undefined : { results: state.organizations },
    error: state.error,
    isLoading: false,
    mutate: state.mutate,
  }),
}));

import Home from "./page";

beforeEach(() => {
  state.error = undefined;
  state.mutate.mockReset();
});

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

  it("says there are no organizations yet when the user has none", () => {
    render(<Home />);
    expect(screen.getByText("No organizations yet")).toBeInTheDocument();
  });

  // A failed read is not "no organizations": it says which read failed and
  // offers a retry, in the same page frame as the empty state.
  it("shows a failed organization read with a retry, not an empty page", () => {
    state.error = { status: 500, message: "Server error" };

    render(<Home />);

    expect(screen.getByText("Couldn't load organizations")).toBeInTheDocument();
    expect(screen.queryByText("No organizations yet")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.mutate).toHaveBeenCalledOnce();
  });
});
