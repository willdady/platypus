import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import UserSettingsError from "./error";

describe("UserSettingsError", () => {
  it("says the page couldn't load and offers to try again", () => {
    const retry = vi.fn();

    render(<UserSettingsError error={new Error("boom")} retry={retry} />);

    expect(screen.getByText("Couldn't load this page")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });
});
