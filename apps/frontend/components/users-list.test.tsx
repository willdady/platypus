import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => ({
  useBackendUrl: () => "http://test",
  useAuth: () => ({ user: { id: "admin1" } }),
}));

const { toastSuccessSpy, toastErrorSpy } = vi.hoisted(() => ({
  toastSuccessSpy: vi.fn(),
  toastErrorSpy: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: {
    error: toastErrorSpy,
    info: vi.fn(),
    success: toastSuccessSpy,
  },
}));

interface User {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  emailVerified: boolean;
  banned?: boolean;
  createdAt: string;
  updatedAt: string;
}

// The `GET /auth/admin/list-users` list this component renders. Set per test.
let users: User[] = [];
const mutateSpy = vi.fn();

vi.mock("swr", () => ({
  __esModule: true,
  default: () => ({
    data: { users },
    error: undefined,
    isLoading: false,
    mutate: mutateSpy,
  }),
}));

import { UsersList } from "./users-list";

// --- Fixtures ----------------------------------------------------------------

const target: User = {
  id: "u2",
  email: "sam@example.com",
  name: "Sam",
  role: "user",
  emailVerified: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

async function confirmDelete() {
  fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
  fireEvent.change(
    screen.getByPlaceholderText("Type 'delete user' to confirm"),
    { target: { value: "delete user" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete user" }));
}

afterEach(() => {
  users = [];
  mutateSpy.mockClear();
  toastSuccessSpy.mockClear();
  toastErrorSpy.mockClear();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("UsersList delete", () => {
  it("deletes through the request module, revalidates, and confirms on success", async () => {
    users = [target];
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<UsersList />);
    await confirmDelete();

    await waitFor(() => expect(mutateSpy).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/auth/admin/remove-user",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userId: "u2" }),
      }),
    );
    expect(toastSuccessSpy).toHaveBeenCalledWith("User Sam has been deleted");
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    users = [target];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(409, { error: "User owns resources" }));
    vi.stubGlobal("fetch", fetchMock);

    render(<UsersList />);
    await confirmDelete();

    await waitFor(() =>
      expect(screen.getByText("User owns resources")).toBeInTheDocument(),
    );
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(toastSuccessSpy).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Delete user" }),
    ).toBeInTheDocument();
  });
});
