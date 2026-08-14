import { describe, it, expect } from "vitest";
import { applyToolDurations } from "./tool-durations.ts";
import type { PlatypusUIMessage } from "../types.ts";

/** An assistant message carrying the given parts, cast at the seam because
 *  the part union is wider than any single fixture needs to be. */
const assistant = (parts: unknown[]): PlatypusUIMessage =>
  ({
    id: "msg-1",
    role: "assistant",
    parts,
  }) as PlatypusUIMessage;

const staticPart = (
  toolCallId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> => ({
  type: "tool-getCard",
  toolCallId,
  state: "output-available",
  input: {},
  output: {},
  ...extra,
});

const dynamicPart = (
  toolCallId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> => ({
  type: "dynamic-tool",
  toolName: "search",
  toolCallId,
  state: "output-available",
  input: {},
  output: {},
  ...extra,
});

/** Reads back the patched metadata without restating the cast in each test. */
const metadataOf = (message: PlatypusUIMessage, index: number) =>
  (message.parts[index] as { toolMetadata?: Record<string, unknown> })
    .toolMetadata;

describe("applyToolDurations", () => {
  it("writes durationMs onto a static tool part", () => {
    const messages = [assistant([staticPart("call-1")])];

    const patched = applyToolDurations(messages, new Map([["call-1", 1234]]));

    expect(metadataOf(patched[0], 0)).toEqual({ durationMs: 1234 });
  });

  // The SDK measures on a high-resolution clock; nothing reads below a
  // millisecond, so the stored figure is not sixteen significant digits.
  it("rounds the high-resolution figure the SDK reports", () => {
    const messages = [assistant([staticPart("call-1")])];

    const patched = applyToolDurations(
      messages,
      new Map([["call-1", 706.9857919998467]]),
    );

    expect(metadataOf(patched[0], 0)).toEqual({ durationMs: 707 });
  });

  it("writes durationMs onto a dynamic tool part", () => {
    const messages = [assistant([dynamicPart("call-1")])];

    const patched = applyToolDurations(messages, new Map([["call-1", 42]]));

    expect(metadataOf(patched[0], 0)).toEqual({ durationMs: 42 });
  });

  it("merges into existing toolMetadata rather than replacing it", () => {
    const messages = [
      assistant([staticPart("call-1", { toolMetadata: { cacheHit: true } })]),
    ];

    const patched = applyToolDurations(messages, new Map([["call-1", 7]]));

    expect(metadataOf(patched[0], 0)).toEqual({
      cacheHit: true,
      durationMs: 7,
    });
  });

  it("leaves tool calls absent from the map untouched", () => {
    const messages = [assistant([staticPart("call-1"), dynamicPart("call-2")])];

    const patched = applyToolDurations(messages, new Map([["call-1", 5]]));

    expect(metadataOf(patched[0], 0)).toEqual({ durationMs: 5 });
    expect(metadataOf(patched[0], 1)).toBeUndefined();
  });

  it("leaves non-tool parts and other messages alone", () => {
    const messages = [
      assistant([{ type: "text", text: "hi" }]),
      assistant([staticPart("call-1")]),
    ];

    const patched = applyToolDurations(messages, new Map([["call-1", 5]]));

    expect(patched[0]).toBe(messages[0]);
    expect(patched[0].parts[0]).toEqual({ type: "text", text: "hi" });
    expect(metadataOf(patched[1], 0)).toEqual({ durationMs: 5 });
  });

  it("returns the input untouched when no durations were recorded", () => {
    const messages = [assistant([staticPart("call-1")])];

    expect(applyToolDurations(messages, new Map())).toBe(messages);
  });

  it("does not mutate the input messages", () => {
    const part = staticPart("call-1", { toolMetadata: { cacheHit: true } });
    const messages = [assistant([part])];

    applyToolDurations(messages, new Map([["call-1", 5]]));

    expect(part.toolMetadata).toEqual({ cacheHit: true });
  });
});
