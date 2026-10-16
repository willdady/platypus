import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import GlobalError from "./global-error";

describe("global-error", () => {
  it("renders a whole document of its own, with the way to try again", () => {
    const html = renderToStaticMarkup(
      <GlobalError error={new Error("layout threw")} retry={vi.fn()} />,
    );

    expect(html).toMatch(/^<html lang="en"/);
    expect(html).toContain("<body");
    expect(html).toContain("Couldn&#x27;t load this page");
    expect(html).toContain("Try again");
  });
});
