import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import ChatLoading from "./loading";

describe("ChatLoading", () => {
  it("announces the Chat as busy while its transcript loads", () => {
    render(<ChatLoading />);

    expect(
      screen.getByRole("status", { name: "Loading chat" }),
    ).toHaveAttribute("aria-busy", "true");
  });
});
