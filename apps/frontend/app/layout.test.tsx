import { describe, it, expect, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-sans" }),
  Geist_Mono: () => ({ variable: "font-mono" }),
}));

import { metadata } from "./layout";

describe("RootLayout metadata", () => {
  it("suffixes every page's title with the app name", () => {
    expect(metadata.title).toEqual({
      default: "Platypus",
      template: "%s | Platypus",
    });
  });

  // Everything but sign-in sits behind auth, so there is nothing to index.
  it("asks search engines not to index or follow any page", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
