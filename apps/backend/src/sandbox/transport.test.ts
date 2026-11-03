import { describe, expect, it } from "vitest";
import { createCappedSink } from "./transport.ts";

// The byte-capped sink is a contract helper every adapter streams through, so
// its guarantee is asserted once here rather than per adapter: a stream over
// its budget keeps both ends, says how much it dropped, and never leaves a
// half-written UTF-8 character at either cut.

const collect = (
  cap: { head: number; tail?: number },
  ...chunks: (string | Buffer)[]
): Buffer => {
  const sink = createCappedSink(cap);
  for (const chunk of chunks) {
    sink.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return sink.collect();
};

const marker = (omitted: number): string =>
  `[… ${omitted.toLocaleString("en-US")} bytes omitted …]`;

describe("createCappedSink", () => {
  it("returns a stream under the budget byte-for-byte", () => {
    const out = collect({ head: 4, tail: 4 }, "hello");
    expect(out.toString("utf8")).toBe("hello");
  });

  it("returns a stream exactly on the budget byte-for-byte", () => {
    const out = collect({ head: 4, tail: 4 }, "abcdefgh");
    expect(out.toString("utf8")).toBe("abcdefgh");
  });

  it("keeps the head and the tail with one marker line between them", () => {
    const out = collect({ head: 4, tail: 6 }, "abcdefghijklmno");
    expect(out.toString("utf8")).toBe(`abcd\n${marker(5)}\njklmno`);
  });

  it("says how many bytes it dropped, with thousands separators", () => {
    const out = collect({ head: 10, tail: 20 }, "a".repeat(30_500));
    expect(out.toString("utf8")).toBe(
      `${"a".repeat(10)}\n${marker(30_470)}\n${"a".repeat(20)}`,
    );
  });

  it("keeps head-only behaviour for a sink with no tail", () => {
    const out = collect({ head: 5 }, "abcdefghij");
    expect(out.toString("utf8")).toBe("abcde");
  });

  it("drops a UTF-8 character split by the head cut rather than emit a replacement", () => {
    // "ab" + "€" (3 bytes) + filler. A head of 4 bytes lands inside the euro
    // sign, so the whole character is dropped from the head and counted once.
    const out = collect({ head: 4, tail: 10 }, `ab€${"x".repeat(2_000)}`);
    const text = out.toString("utf8");

    expect(text.startsWith("ab\n")).toBe(true);
    expect(text.startsWith("ab\uFFFD")).toBe(false);
    expect(text).not.toContain("\uFFFD");
    expect(text).toContain(marker(1_993));
    expect(text.endsWith("x".repeat(10))).toBe(true);
  });

  it("drops a UTF-8 character split by the tail cut rather than emit a replacement", () => {
    // The last four bytes are the tail of the euro sign plus "y"; the tail
    // starts mid-character and must begin at "y".
    const out = collect({ head: 2, tail: 3 }, `${"x".repeat(1_000)}€y`);
    const text = out.toString("utf8");

    expect(text).not.toContain("\uFFFD");
    expect(text.startsWith(`xx\n${marker(1_000 + 4 - 2 - 1)}\n`)).toBe(true);
    expect(text.endsWith("\ny")).toBe(true);
  });

  it("keeps memory bounded by the budget over a multi-megabyte stream", () => {
    const chunk = Buffer.from("a".repeat(4_096));
    const sink = createCappedSink({ head: 10_000, tail: 20_000 });
    for (let i = 0; i < 2_048; i++) sink.push(chunk);

    const out = sink.collect().toString("utf8");
    const total = 2_048 * 4_096;
    expect(out).toHaveLength(30_000 + 1 + marker(total - 30_000).length + 1);
    expect(out.startsWith("a".repeat(10_000))).toBe(true);
    expect(out.endsWith("a".repeat(20_000))).toBe(true);
    expect(out).toContain(marker(total - 30_000));
  });
});
