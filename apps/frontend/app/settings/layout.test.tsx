import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/protected-route", () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/settings-shell", () => ({
  SettingsShell: ({
    headerLeft,
    children,
  }: {
    headerLeft?: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      <header>{headerLeft}</header>
      <main>{children}</main>
    </div>
  ),
}));

vi.mock("@/components/back-button", () => ({
  BackButton: ({
    variant,
    fallbackHref,
  }: {
    variant?: string;
    fallbackHref?: string;
  }) => (
    <button
      aria-label="Back"
      data-variant={variant}
      data-fallback-href={fallbackHref}
    />
  ),
}));

import UserSettingsLayout from "./layout";

describe("UserSettingsLayout header", () => {
  it("gives the header Back the profile root as its fallback", () => {
    render(
      <UserSettingsLayout>
        <p>page</p>
      </UserSettingsLayout>,
    );

    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toHaveAttribute("data-variant", "header");
    expect(back).toHaveAttribute("data-fallback-href", "/settings");
  });
});
