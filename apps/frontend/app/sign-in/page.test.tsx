import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import SignInPage from "./page";

/**
 * A distinct backend URL per test gives each its own SWR cache entry for the
 * registration read — `useSWR` caches by key at module scope, so a shared key
 * would let one test observe another's answer.
 */
let mockBackendUrl = "http://backend-0.test";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => mockBackendUrl,
  useAuth: () => ({
    authClient: { signIn: { email: vi.fn() } },
  }),
}));

/** What the backend's registration endpoint answers. */
const stubRegistration = (open: boolean) => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ open }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("SignInPage", () => {
  let backendCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBackendUrl = `http://backend-${++backendCounter}.test`;
  });

  it("offers Sign up while registration is open", async () => {
    stubRegistration(true);

    render(<SignInPage />);

    expect(
      await screen.findByRole("link", { name: "Sign up" }),
    ).toHaveAttribute("href", "/sign-up");
  });

  it("does not offer Sign up when registration requires an invitation", async () => {
    const fetchMock = stubRegistration(false);

    render(<SignInPage />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `${mockBackendUrl}/registration`,
        expect.anything(),
      ),
    );
    expect(
      screen.queryByRole("link", { name: "Sign up" }),
    ).not.toBeInTheDocument();
    // Signing in is untouched by the requirement.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
