import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HeaderHomeButton } from "./header-home-button";

describe("HeaderHomeButton", () => {
  it("links the app home by default", () => {
    render(<HeaderHomeButton />);

    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("links where it is told and takes that name", () => {
    render(
      <HeaderHomeButton href="/org1/workspace/ws1" label="Workspace home" />,
    );

    expect(
      screen.getByRole("link", { name: "Workspace home" }),
    ).toHaveAttribute("href", "/org1/workspace/ws1");
  });
});
