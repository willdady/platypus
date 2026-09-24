import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/contexts-list", () => ({
  ContextsList: () => null,
}));

// Defaults to a *warm* SWR cache: the fetched global context is already
// present on the very first render, as happens when navigating back from the
// Edit Workspace Context screen (which subscribes to the same SWR key).
const WARM = {
  data: {
    results: [
      { id: "ctx1", workspaceId: null, content: "saved global context" },
    ],
  },
  isLoading: false,
  error: undefined as unknown,
};
const swrState = vi.hoisted(() => ({
  response: {} as { data?: unknown; isLoading: boolean; error?: unknown },
}));
const mutate = vi.fn();

vi.mock("swr", () => ({
  useSWRConfig: () => ({ cache: new Map() }),
  __esModule: true,
  default: () => ({ ...swrState.response, mutate }),
}));

import ContextsPage from "./page";

// --- Tests -------------------------------------------------------------------

describe("ContextsPage global context field", () => {
  beforeEach(() => {
    swrState.response = WARM;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the saved global context immediately when SWR data is already warm on mount", () => {
    render(<ContextsPage />);

    expect(
      screen.getByDisplayValue("saved global context"),
    ).toBeInTheDocument();
  });

  it("hides the editor and disables Save until the read lands", () => {
    swrState.response = { data: undefined, isLoading: true };
    render(<ContextsPage />);

    expect(screen.getByLabelText("Loading global context")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows the failure and keeps Save disabled when the read fails cold", () => {
    swrState.response = {
      data: undefined,
      isLoading: false,
      error: { message: "Boom" },
    };
    render(<ContextsPage />);

    expect(
      screen.getByText("Failed to load global context. Boom"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
