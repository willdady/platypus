import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import InvitePage from "./page";

describe("InvitePage", () => {
  it("asks for the invitation link again", () => {
    render(<InvitePage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Open your invitation link",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The link you used is no longer in the address bar.", {
        exact: false,
      }),
    ).toBeInTheDocument();
  });
});
