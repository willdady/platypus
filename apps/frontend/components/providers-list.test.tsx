import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Provider } from "@platypus/schemas";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/app/client-context", () => ({
  useBackendUrl: () => "http://test",
}));

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => ({
    user: { id: "u1" },
    isOrgAdmin: true,
    actor: "org-admin",
    workspaceDelegation: null,
  }),
}));

type ProviderWithScope = Provider & { scope: "organization" | "workspace" };

// The `GET .../providers` list this component renders. Set per test.
let providers: ProviderWithScope[] = [];

vi.mock("swr", () => ({
  __esModule: true,
  default: (key: string | null) => {
    if (key?.includes("/providers")) {
      return {
        data: { results: providers },
        error: undefined,
        isLoading: false,
        mutate: mutateSpy,
      };
    }
    // Workspace lookup (providerSelfManagement) — unused by these tests.
    return {
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    };
  },
}));

const mutateSpy = vi.fn();

import { ProvidersList } from "./providers-list";

// --- Helpers -----------------------------------------------------------------

const orgProvider: ProviderWithScope = {
  id: "p1",
  name: "Shared OpenAI",
  providerType: "OpenAI",
  scope: "organization",
} as unknown as ProviderWithScope;

/** A refused detach, carrying the reason the backend gave. */
function mockRefusedDetach(reason: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({ error: reason }),
  } as unknown as Response);
}

function openDetachDialog() {
  fireEvent.click(screen.getByText("Shared OpenAI"));
}

// --- Tests -------------------------------------------------------------------

describe("ProvidersList detach", () => {
  afterEach(() => {
    providers = [];
    mutateSpy.mockClear();
    vi.restoreAllMocks();
  });

  it("surfaces the backend's reason and keeps the row when detach is refused", async () => {
    providers = [orgProvider];
    const fetchMock = mockRefusedDetach(
      "This provider is in use by an agent in this workspace",
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ProvidersList orgId="org1" workspaceId="ws1" />);
    openDetachDialog();
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "This provider is in use by an agent in this workspace",
        ),
      ).toBeInTheDocument(),
    );

    // A refused detach must not revalidate the list.
    expect(mutateSpy).not.toHaveBeenCalled();
    // The dialog stays open on the same provider rather than silently closing.
    expect(screen.getByText("Organization Provider")).toBeInTheDocument();
  });

  it("revalidates and closes the dialog when detach succeeds", async () => {
    providers = [orgProvider];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: "Detached" }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    render(<ProvidersList orgId="org1" workspaceId="ws1" />);
    openDetachDialog();
    fireEvent.click(screen.getByRole("button", { name: /Detach/ }));

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(screen.queryByText("Organization Provider")).not.toBeInTheDocument();
  });
});
