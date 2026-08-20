import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/contexts-list", () => ({
  ContextsList: () => null,
}));

// Simulates a *warm* SWR cache: the fetched global context is already present
// on the very first render, as happens when navigating back from the Edit
// Workspace Context screen (which subscribes to the same SWR key).
vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: {
      results: [
        { id: "ctx1", workspaceId: null, content: "saved global context" },
      ],
    },
    mutate: vi.fn(),
  }),
}));

import ContextsPage from "./page";

// --- Tests -------------------------------------------------------------------

describe("ContextsPage global context field", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the saved global context immediately when SWR data is already warm on mount", () => {
    render(<ContextsPage />);

    expect(
      screen.getByDisplayValue("saved global context"),
    ).toBeInTheDocument();
  });
});
