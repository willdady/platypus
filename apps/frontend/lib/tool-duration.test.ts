import { describe, it, expect } from "vitest";
import {
  formatToolDuration,
  toolCallDurationMs,
  toolDurationMs,
} from "./tool-duration";

describe("formatToolDuration", () => {
  it("renders sub-second durations in milliseconds", () => {
    expect(formatToolDuration(842)).toBe("842ms");
  });

  // A third of the calls on a real chat round to zero milliseconds; a bare
  // `0ms` reads as a field that failed to populate.
  it("renders a sub-millisecond duration as less than a millisecond", () => {
    expect(formatToolDuration(0)).toBe("<1ms");
    expect(formatToolDuration(1)).toBe("1ms");
  });

  it("switches from milliseconds to seconds at 1000ms", () => {
    expect(formatToolDuration(999)).toBe("999ms");
    expect(formatToolDuration(1000)).toBe("1.0s");
  });

  it("renders seconds to one decimal place", () => {
    expect(formatToolDuration(1234)).toBe("1.2s");
  });

  it("switches from seconds to minutes at 60s", () => {
    expect(formatToolDuration(59_900)).toBe("59.9s");
    expect(formatToolDuration(60_000)).toBe("1m 00s");
  });

  it("zero-pads the seconds component of a minutes-and-seconds duration", () => {
    expect(formatToolDuration(63_000)).toBe("1m 03s");
    expect(formatToolDuration(754_000)).toBe("12m 34s");
  });
});

describe("toolDurationMs", () => {
  it("reads a numeric durationMs out of tool metadata", () => {
    expect(toolDurationMs({ durationMs: 1234 })).toBe(1234);
  });

  it("ignores metadata that carries no usable duration", () => {
    expect(toolDurationMs(undefined)).toBeUndefined();
    expect(toolDurationMs({})).toBeUndefined();
    expect(toolDurationMs({ durationMs: "1234" })).toBeUndefined();
    expect(toolDurationMs({ durationMs: null })).toBeUndefined();
  });
});

describe("toolCallDurationMs", () => {
  it("prefers the part's own recorded duration", () => {
    expect(
      toolCallDurationMs(
        { durationMs: 500 },
        { toolDurations: { "call-1": 999 } },
        "call-1",
      ),
    ).toBe(500);
  });

  // The live case: during the turn that produced it, the SDK hands back a tool
  // part with no metadata, so the message's map is the only carrier.
  it("falls back to the message's map when the part carries nothing", () => {
    expect(
      toolCallDurationMs(
        undefined,
        { toolDurations: { "call-1": 842 } },
        "call-1",
      ),
    ).toBe(842);
  });

  it("reads the entry for the right tool call", () => {
    const metadata = { toolDurations: { "call-1": 10, "call-2": 20 } };

    expect(toolCallDurationMs(undefined, metadata, "call-2")).toBe(20);
  });

  it("has no duration for a call absent from the map", () => {
    expect(
      toolCallDurationMs(
        undefined,
        { toolDurations: { "call-1": 10 } },
        "call-9",
      ),
    ).toBeUndefined();
  });

  // Messages written before either carrier existed, which the docs promise
  // render no time rather than a zero.
  it("has no duration when neither carrier has one", () => {
    expect(toolCallDurationMs(undefined, undefined, "call-1")).toBeUndefined();
    expect(toolCallDurationMs({}, {}, "call-1")).toBeUndefined();
    expect(
      toolCallDurationMs(undefined, { agentId: "agent-1" }, "call-1"),
    ).toBeUndefined();
  });

  it("ignores a non-numeric value in either carrier", () => {
    expect(
      toolCallDurationMs({ durationMs: "500" }, undefined, "call-1"),
    ).toBeUndefined();
    expect(
      toolCallDurationMs(
        undefined,
        { toolDurations: { "call-1": "842" } },
        "call-1",
      ),
    ).toBeUndefined();
  });

  it("keeps a zero from the map rather than reading it as absent", () => {
    expect(
      toolCallDurationMs(
        undefined,
        { toolDurations: { "call-1": 0 } },
        "call-1",
      ),
    ).toBe(0);
  });
});
