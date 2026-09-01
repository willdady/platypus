import { describe, it, expect } from "vitest";
import { cachedTokenBreakdown } from "./cached-tokens";

const raw = (n: number) => n.toLocaleString();

describe("cachedTokenBreakdown", () => {
  it("renders the read and write copy, formatted by the caller's formatter", () => {
    expect(
      cachedTokenBreakdown(
        { cacheReadTokens: 2_700, cacheWriteTokens: 150 },
        raw,
      ),
    ).toEqual([
      "of which 2,700 read from cache",
      "of which 150 written to cache",
    ]);
  });

  it("renders only the read line where the Provider reported no write", () => {
    expect(cachedTokenBreakdown({ cacheReadTokens: 900 }, raw)).toEqual([
      "of which 900 read from cache",
    ]);
  });

  it("renders only the write line where the Provider reported no read", () => {
    expect(cachedTokenBreakdown({ cacheWriteTokens: 150 }, raw)).toEqual([
      "of which 150 written to cache",
    ]);
  });

  it("renders nothing where the Provider reported no cache detail at all", () => {
    expect(cachedTokenBreakdown({}, raw)).toEqual([]);
  });
});
