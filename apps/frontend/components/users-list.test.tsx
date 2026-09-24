import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import {
  authMock,
  toastMock,
  swrMock,
  mockScopedSWR,
  resetListHarness,
  renderList,
  confirmDialog,
  stubAcceptedSave,
  stubRejectedSave,
  mutate,
  toastSuccess,
} from "@/lib/list-test-harness";

// --- Module mocks ------------------------------------------------------------

vi.mock("@/components/auth-provider", () => authMock);
vi.mock("sonner", () => toastMock);
vi.mock("swr", () => swrMock);

import { UsersList } from "./users-list";

// --- Fixtures ----------------------------------------------------------------

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

const target: User = {
  id: "u2",
  email: "sam@example.com",
  name: "Sam",
  role: "user",
  emailVerified: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

/**
 * `GET /auth/admin/list-users` answers with `{ users }`, not the
 * `{ results }` every other list returns, so it registers a raw payload.
 */
function renderUsers(users: User[]) {
  mockScopedSWR({ "list-users": { data: { users } } });
  return renderList(<UsersList />);
}

async function confirmDelete() {
  fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
  fireEvent.change(
    screen.getByPlaceholderText("Type 'delete user' to confirm"),
    { target: { value: "delete user" } },
  );
  await confirmDialog("Delete user");
}

beforeEach(resetListHarness);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- Tests -------------------------------------------------------------------

describe("UsersList delete", () => {
  it("deletes through the request module, revalidates, and confirms on success", async () => {
    const fetchMock = stubAcceptedSave();

    renderUsers([target]);
    await confirmDelete();

    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://test/auth/admin/remove-user",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userId: "u2" }),
      }),
    );
    expect(toastSuccess).toHaveBeenCalledWith("User Sam has been deleted");
  });

  it("surfaces the backend's reason inline and does not revalidate when delete is refused", async () => {
    stubRejectedSave("User owns resources", 409);

    renderUsers([target]);
    await confirmDelete();

    await waitFor(() =>
      expect(screen.getByText("User owns resources")).toBeInTheDocument(),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Delete user" }),
    ).toBeInTheDocument();
  });
});

describe("UsersList list states", () => {
  it("shows the empty state when no users came back", () => {
    renderUsers([]);

    expect(screen.getByText("No users found.")).toBeInTheDocument();
  });

  it("surfaces a failed read rather than rendering an empty list", () => {
    mockScopedSWR({ "list-users": { error: new Error("500") } });
    renderList(<UsersList />);

    expect(screen.getByText(/Failed to load users/)).toBeInTheDocument();
  });

  it("shows the loading state while the read is in flight", () => {
    mockScopedSWR({ "list-users": { isLoading: true } });
    renderList(<UsersList />);

    expect(
      screen.getByRole("status", { name: "Loading users" }),
    ).toHaveAttribute("aria-busy", "true");
    // The table's real headings hold the frame while its rows load.
    expect(
      screen.getByRole("columnheader", { name: "Created" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No users found.")).not.toBeInTheDocument();
  });
});
