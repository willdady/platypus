import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  applyToolInputClearing,
  CLEARED_TOOL_INPUT_MARKER,
} from "./tool-input-clearing.ts";

type Output = Extract<
  ModelMessage,
  { role: "tool" }
>["content"][number] extends infer P
  ? P extends { type: "tool-result"; output: infer O }
    ? O
    : never
  : never;

/** One tool call and its result, as the assistant/tool message pair a step leaves. */
const call = (
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown>,
  output: Output = { type: "json", value: { ok: true } },
): ModelMessage[] => [
  {
    role: "assistant",
    content: [{ type: "tool-call", toolCallId, toolName, input }],
  },
  {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName, output }],
  },
];

const inputOf = (messages: ModelMessage[], toolCallId: string): unknown => {
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string")
      continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.toolCallId === toolCallId)
        return part.input;
    }
  }
  throw new Error(`no call ${toolCallId}`);
};

const ABOVE = { occupancy: 80, contextWindow: 100 };

const writes = (n: number): ModelMessage[] =>
  Array.from({ length: n }, (_, i) =>
    call("fsWrite", `w${i}`, {
      path: `f${i}.txt`,
      content: `body ${i}`,
      mode: "create",
    }),
  ).flat();

describe("applyToolInputClearing", () => {
  it("clears `content` of all but the 4 newest successful fsWrite calls", () => {
    const messages = writes(6);
    const cleared = applyToolInputClearing(messages, ABOVE);

    expect(inputOf(cleared, "w0")).toEqual({
      path: "f0.txt",
      content: CLEARED_TOOL_INPUT_MARKER,
      mode: "create",
    });
    expect(inputOf(cleared, "w1")).toMatchObject({
      content: CLEARED_TOOL_INPUT_MARKER,
    });
    for (const id of ["w2", "w3", "w4", "w5"]) {
      expect(inputOf(cleared, id)).toBe(inputOf(messages, id));
    }
    // Never mutates what it was given: the stored Transcript is the source.
    expect(inputOf(messages, "w0")).toMatchObject({ content: "body 0" });
  });

  it("keeps a failed fsEdit's input at any occupancy", () => {
    const failed = call(
      "fsEdit",
      "e0",
      { path: "a.txt", oldString: "x", newString: "y" },
      { type: "error-text", value: "oldString not found" },
    );
    const messages = [...failed, ...writes(6)];
    const cleared = applyToolInputClearing(messages, {
      occupancy: 100,
      contextWindow: 100,
    });
    expect(inputOf(cleared, "e0")).toBe(inputOf(messages, "e0"));
  });

  it("clears both strings of a successful stale fsEdit, keeping its path", () => {
    const messages = [
      ...call("fsEdit", "e0", {
        path: "a.txt",
        oldString: "x",
        newString: "y",
      }),
      ...writes(4),
    ];
    expect(inputOf(applyToolInputClearing(messages, ABOVE), "e0")).toEqual({
      path: "a.txt",
      oldString: CLEARED_TOOL_INPUT_MARKER,
      newString: CLEARED_TOOL_INPUT_MARKER,
    });
  });

  it("keeps updateWidgetData's `data` when its result is an `{ error }`, clears it on success", () => {
    const input = (id: string) => ({
      dashboardId: "d",
      widgetId: id,
      type: "markdown",
      data: { markdown: "big" },
    });
    const messages = [
      ...call("updateWidgetData", "u0", input("a"), {
        type: "json",
        value: { error: "Widget not found" },
      }),
      ...call("updateWidgetData", "u1", input("b")),
      ...writes(4),
    ];
    const cleared = applyToolInputClearing(messages, ABOVE);
    expect(inputOf(cleared, "u0")).toBe(inputOf(messages, "u0"));
    expect(inputOf(cleared, "u1")).toEqual({
      ...input("b"),
      data: CLEARED_TOOL_INPUT_MARKER,
    });
  });

  it("never touches a tool outside the allowlist", () => {
    const messages = [
      ...call("docs__write", "m0", { content: "big" }),
      ...call("shellExec", "s0", { command: "cat > f <<EOF big EOF" }),
      ...writes(4),
    ];
    expect(applyToolInputClearing(messages, ABOVE)).toBe(messages);
  });

  it("leaves a call with no result yet alone", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "p0",
            toolName: "fsWrite",
            input: { path: "p", content: "c", mode: "create" },
          },
        ],
      },
      ...writes(4),
    ];
    expect(applyToolInputClearing(messages, ABOVE)).toBe(messages);
  });

  it.each([
    ["below the threshold", { occupancy: 69, contextWindow: 100 }],
    ["with no declared window", { occupancy: 80 }],
    ["with no occupancy reading", { contextWindow: 100 }],
  ])("returns the same array %s", (_, reading) => {
    const messages = writes(6);
    expect(applyToolInputClearing(messages, reading)).toBe(messages);
  });

  it("returns the same array once everything stale is already cleared", () => {
    const once = applyToolInputClearing(writes(6), ABOVE);
    expect(applyToolInputClearing(once, ABOVE)).toBe(once);
  });
});
