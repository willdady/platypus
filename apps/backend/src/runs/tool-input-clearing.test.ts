import { describe, it, expect } from "vitest";
import { CLEARED_TOOL_INPUT_MARKER } from "@platypus/schemas";
import type { ModelMessage } from "ai";
import {
  applyToolInputClearing,
  clearToolInputsToTarget,
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

/** Body large enough that clearing it frees more than the marker replaces. */
const BODY = "b".repeat(1_400);

const ABOVE = { occupancy: 80, contextWindow: 100 };

const writes = (n: number, prefix = "w"): ModelMessage[] =>
  Array.from({ length: n }, (_, i) =>
    call("fsWrite", `${prefix}${i}`, {
      path: `f${i}.txt`,
      content: BODY,
      mode: "create",
    }),
  ).flat();

const clearedWriteIds = (messages: ModelMessage[]): string[] =>
  messages.flatMap((message) => {
    if (message.role !== "assistant" || typeof message.content === "string")
      return [];
    return message.content.flatMap((part) => {
      if (part.type !== "tool-call") return [];
      const input = part.input as Record<string, unknown>;
      return input.content === CLEARED_TOOL_INPUT_MARKER
        ? [part.toolCallId]
        : [];
    });
  });

describe("applyToolInputClearing", () => {
  it("clears `content` of the oldest writes, stopping at the batch floor", () => {
    const messages = writes(8);
    const cleared = applyToolInputClearing(messages, ABOVE);

    for (const id of ["w0", "w1", "w2", "w3"]) {
      expect(inputOf(cleared, id)).toMatchObject({
        content: CLEARED_TOOL_INPUT_MARKER,
      });
    }
    for (const id of ["w4", "w5", "w6", "w7"]) {
      expect(inputOf(cleared, id)).toBe(inputOf(messages, id));
    }
    // Never mutates what it was given: the stored Transcript is the source.
    expect(inputOf(messages, "w0")).toMatchObject({ content: BODY });
  });

  it("uses a caller-supplied conversation size rather than re-measuring", () => {
    // The backend hands both passes the size of the messages the step started
    // with; input clearing must not measure the result-cleared conversation
    // again, or it would size its batch from a picture the frontend mirror
    // never sees.
    const messages = writes(12);
    const cleared = applyToolInputClearing(messages, {
      ...ABOVE,
      conversationSize: 2_000,
    });

    expect(clearedWriteIds(cleared)).toEqual(["w0", "w1", "w2", "w3"]);
  });

  it("clears a batch sized to the target rather than everything stale", () => {
    const messages = writes(12);
    const cleared = applyToolInputClearing(messages, ABOVE);

    // Eight are stale; the 0.4 target reaches past all of them, so this is
    // the maximum batch rather than a partial one.
    expect(clearedWriteIds(cleared)).toEqual([
      "w0",
      "w1",
      "w2",
      "w3",
      "w4",
      "w5",
      "w6",
      "w7",
    ]);
    for (let i = 8; i < 12; i += 1) {
      expect(inputOf(cleared, `w${i}`)).toBe(inputOf(messages, `w${i}`));
    }
  });

  it("leaves the prefix byte-identical across the steps the target buys", () => {
    const pass = clearToolInputsToTarget(writes(12), ABOVE, {
      thresholdFraction: 0.7,
      targetFraction: 0.5,
      keepRecent: 4,
      minBatch: 4,
    });
    const grown = [...pass, ...writes(2, "later")];

    expect(
      applyToolInputClearing(grown, { occupancy: 69, contextWindow: 100 }),
    ).toBe(grown);
  });

  it("keeps a failed fsEdit's input at any occupancy", () => {
    const failed = call(
      "fsEdit",
      "e0",
      {
        path: "a.txt",
        oldString: "o".repeat(1_000),
        newString: "n".repeat(1_000),
      },
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
    const oldString = "o".repeat(1_000);
    const newString = "n".repeat(1_000);
    const messages = [
      ...call("fsEdit", "e0", { path: "a.txt", oldString, newString }),
      ...writes(8),
    ];
    expect(inputOf(applyToolInputClearing(messages, ABOVE), "e0")).toEqual({
      path: "a.txt",
      oldString: CLEARED_TOOL_INPUT_MARKER,
      newString: CLEARED_TOOL_INPUT_MARKER,
    });
  });

  it("keeps an fsWrite's `content` when its result is an `{ error }`, clears it on success", () => {
    const input = (id: string) => ({
      path: `${id}.txt`,
      content: BODY,
      mode: "create",
    });
    const messages = [
      ...call("fsWrite", "u0", input("a"), {
        type: "json",
        value: { error: "File already exists" },
      }),
      ...call("fsWrite", "u1", input("b")),
      ...writes(8),
    ];
    const cleared = applyToolInputClearing(messages, ABOVE);
    expect(inputOf(cleared, "u0")).toBe(inputOf(messages, "u0"));
    expect(inputOf(cleared, "u1")).toEqual({
      ...input("b"),
      content: CLEARED_TOOL_INPUT_MARKER,
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
            input: { path: "p", content: BODY, mode: "create" },
          },
        ],
      },
      ...writes(4),
    ];
    expect(applyToolInputClearing(messages, ABOVE)).toBe(messages);
  });

  it("clears nothing for input no larger than the marker", () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      call("fsWrite", `s${i}`, { path: "p", content: "tiny" }),
    ).flat();
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

  it("returns the same array once every stale call is already cleared", () => {
    const messages = writes(12);
    const clearedAll = clearToolInputsToTarget(messages, ABOVE, {
      thresholdFraction: 0,
      targetFraction: 0,
      keepRecent: 0,
      minBatch: 1,
    });
    expect(applyToolInputClearing(clearedAll, ABOVE)).toBe(clearedAll);
  });
});
