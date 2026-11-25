import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-themes", () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));

import { ModeToggle } from "./mode-toggle";

describe("ModeToggle", () => {
  it("takes its size from the Button size prop, not a className override", () => {
    render(<ModeToggle />);

    const trigger = screen.getByRole("button", { name: "Toggle theme" });
    expect(trigger).toHaveClass("size-7");
    expect(trigger).not.toHaveClass("h-9");
  });
});
