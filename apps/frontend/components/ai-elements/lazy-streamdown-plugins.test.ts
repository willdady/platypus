import { describe, it, expect, vi } from "vitest";
import { lazyCode } from "./lazy-streamdown-plugins";

describe("lazyCode", () => {
  it("highlights a block once the highlighter has loaded", async () => {
    const onResult = vi.fn();

    const first = lazyCode.highlight(
      {
        code: "const answer = 42;",
        language: "ts",
        themes: lazyCode.getThemes(),
      },
      onResult,
    );

    expect(first).toBeNull();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalled(), {
      timeout: 5000,
    });
    const tokens = onResult.mock.calls[0][0].tokens.flat();
    expect(tokens.map((t: { content: string }) => t.content).join("")).toBe(
      "const answer = 42;",
    );
    // Split into more than one coloured run: highlighted, not plain text.
    expect(tokens.length).toBeGreaterThan(1);
  });
});
