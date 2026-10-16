import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ItemContent } from "./item";

describe("ItemContent", () => {
  // Without min-w-0 a flex child can't shrink below its content, so a
  // truncated line inside it overflows the card instead of showing an ellipsis.
  it("may shrink below its content's width", () => {
    render(<ItemContent>Long text</ItemContent>);

    expect(screen.getByText("Long text")).toHaveClass("min-w-0");
  });

  it("still merges the caller's classes", () => {
    render(<ItemContent className="gap-4">Long text</ItemContent>);

    expect(screen.getByText("Long text")).toHaveClass("min-w-0", "gap-4");
  });
});
