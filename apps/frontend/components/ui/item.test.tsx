import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ItemContent } from "./item";

describe("ItemContent", () => {
  it("may shrink below its content's width", () => {
    render(<ItemContent>Long text</ItemContent>);

    expect(screen.getByText("Long text")).toHaveClass("min-w-0");
  });

  it("still merges the caller's classes", () => {
    render(<ItemContent className="gap-4">Long text</ItemContent>);

    expect(screen.getByText("Long text")).toHaveClass("min-w-0", "gap-4");
  });
});
