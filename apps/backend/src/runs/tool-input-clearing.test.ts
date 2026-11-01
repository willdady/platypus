import { describe, it, expect } from "vitest";
import {
  CLEARED_TOOL_INPUT_MARKER,
  TOOL_RESULT_CLEARING_BATCH,
} from "@platypus/schemas";
import type { ModelMessage } from "ai";
import {
  applyToolInputClearing,
  clearStaleToolInputs,
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
  it("clears `content` of the oldest writes in one batch", () => {
    const messages = writes(8);
    const cleared = applyToolInputClearing(messages, ABOVE);

    // floor((8 - 4) / 4) * 4 = 4: the oldest batch, with four kept live.
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

  it("clears a batch rather than everything stale", () => {
    const messages = writes(12);
    const cleared = applyToolInputClearing(messages, ABOVE);

    // floor((12 - 4) / 4) * 4 = 8: two batches, not all eight stale writes.
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

  it("stays engaged when an earlier reading on the path crossed the trigger", () => {
    // The flip-flop, on the write-input sibling: a prior turn crossed 0.7 and
    // moved the boundary, so the latest reading fell back under it.
    const messages = writes(8);

    expect(
      clearedWriteIds(
        applyToolInputClearing(messages, {
          occupancy: 620,
          contextWindow: 1_000,
          priorReadings: [
            { inputTokens: 900, outputTokens: 20 },
            { inputTokens: 600, outputTokens: 20 },
          ],
        }),
      ),
    ).toEqual(["w0", "w1", "w2", "w3"]);
  });

  it("does not engage below the trigger without a qualifying earlier reading", () => {
    const messages = writes(8);
    expect(
      applyToolInputClearing(messages, {
        occupancy: 620,
        contextWindow: 1_000,
        priorReadings: [{ inputTokens: 600, outputTokens: 20 }, null],
      }),
    ).toBe(messages);
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
    const messages = [...failed, ...writes(8)];
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
      ...writes(7),
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
      ...writes(7),
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
      ...writes(8),
    ];
    const cleared = applyToolInputClearing(messages, ABOVE);
    expect(inputOf(cleared, "m0")).toBe(inputOf(messages, "m0"));
    expect(inputOf(cleared, "s0")).toBe(inputOf(messages, "s0"));
    expect(clearedWriteIds(cleared)).toEqual(["w0", "w1", "w2", "w3"]);
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
      ...writes(8),
    ];
    const cleared = applyToolInputClearing(messages, ABOVE);
    expect(inputOf(cleared, "p0")).toBe(inputOf(messages, "p0"));
    expect(clearedWriteIds(cleared)).toEqual(["w0", "w1", "w2", "w3"]);
  });

  it("clears by count rather than by payload size", () => {
    // The boundary no longer depends on bytes freed, so a small write in the
    // oldest batch is cleared along with its neighbours.
    const messages = Array.from({ length: 8 }, (_, i) =>
      call("fsWrite", `s${i}`, { path: "p", content: "tiny" }),
    ).flat();
    expect(clearedWriteIds(applyToolInputClearing(messages, ABOVE))).toEqual([
      "s0",
      "s1",
      "s2",
      "s3",
    ]);
  });

  it.each([
    ["below the threshold", { occupancy: 69, contextWindow: 100 }],
    ["with no declared window", { occupancy: 80 }],
    ["with no occupancy reading", { contextWindow: 100 }],
  ])("returns the same array %s", (_, reading) => {
    const messages = writes(8);
    expect(applyToolInputClearing(messages, reading)).toBe(messages);
  });

  it("returns the same array once every clearable call is already cleared", () => {
    const messages = writes(8);
    const clearedAll = clearStaleToolInputs(messages, {
      keepRecent: 0,
      batchSize: TOOL_RESULT_CLEARING_BATCH,
    });
    expect(applyToolInputClearing(clearedAll, ABOVE)).toBe(clearedAll);
  });
});

describe("batched input boundary", () => {
  const pass = (messages: ModelMessage[]) =>
    applyToolInputClearing(messages, ABOVE);

  it("leaves every earlier message byte-identical until the next full batch arrives", () => {
    let grown = pass(writes(8));
    expect(clearedWriteIds(grown)).toEqual(["w0", "w1", "w2", "w3"]);

    for (let added = 1; added < TOOL_RESULT_CLEARING_BATCH; added += 1) {
      grown = [...grown, ...writes(1, `later${added}-`)];
      expect(pass(grown)).toBe(grown);
    }
  });

  it("moves the boundary by exactly one batch on the Bth append", () => {
    let grown = pass(writes(8));
    for (let added = 1; added < TOOL_RESULT_CLEARING_BATCH; added += 1) {
      grown = [...grown, ...writes(1, `later${added}-`)];
    }
    const before = grown;
    const next = [...grown, ...writes(1, "last-")];

    const after = pass(next);

    before.slice(0, 4).forEach((message, index) => {
      expect(after[index]).toBe(message);
    });
    expect(clearedWriteIds(after)).toHaveLength(8);
    after.slice(-8).forEach((message, index) => {
      expect(message).toBe(next[next.length - 8 + index]);
    });
  });
});
