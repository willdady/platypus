import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const { authState, updateUser } = vi.hoisted(() => {
  const updateUser = vi.fn();
  return {
    updateUser,
    authState: {
      user: null as {
        id: string;
        name: string;
        email: string;
        timezone?: string | null;
      } | null,
      authClient: { updateUser },
    },
  };
});

vi.mock("@/components/auth-provider", () => ({
  useAuth: () => authState,
}));

import UserSettingsPage from "./page";

const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;

beforeEach(() => {
  updateUser.mockReset().mockResolvedValue({ error: null });
  authState.user = { id: "u1", name: "Ada", email: "ada@example.com" };
});

const timezoneField = () => screen.getByRole("combobox", { name: "Timezone" });
const save = () =>
  fireEvent.click(screen.getByRole("button", { name: "Save timezone" }));

describe("Profile Settings timezone", () => {
  it("shows the saved timezone", () => {
    authState.user!.timezone = "Australia/Melbourne";
    render(<UserSettingsPage />);

    expect(timezoneField()).toHaveTextContent("Australia/Melbourne");
  });

  it("fills the detected zone without saving, then saves it on submit", async () => {
    render(<UserSettingsPage />);
    expect(timezoneField()).toHaveTextContent("Not set");

    fireEvent.click(
      screen.getByRole("button", { name: `Use detected (${detected})` }),
    );

    expect(timezoneField()).toHaveTextContent(detected);
    expect(updateUser).not.toHaveBeenCalled();

    save();
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith({ timezone: detected }),
    );
  });

  it("clears the timezone back to unset", async () => {
    authState.user!.timezone = "Australia/Melbourne";
    render(<UserSettingsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Clear timezone" }));
    expect(timezoneField()).toHaveTextContent("Not set");

    save();
    await waitFor(() =>
      expect(updateUser).toHaveBeenCalledWith({ timezone: null }),
    );
  });

  it("does not save anything on first visit", () => {
    render(<UserSettingsPage />);
    expect(updateUser).not.toHaveBeenCalled();
  });
});
