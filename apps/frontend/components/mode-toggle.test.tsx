import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-themes", () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));

import { ModeToggle } from "./mode-toggle";

describe("ModeToggle", () => {
  it("takes its size from the Button size prop, not a className override", () => {
    render(<ModeToggle />);

    const trigger = screen.getByRole("button", { name: "Toggle theme" });
    expect(trigger).toHaveClass("size-7");
    // The default size's height, which a `className="size-7"` on a
    // default-size Button would leave in place.
    expect(trigger).not.toHaveClass("h-9");
  });
});
