import { describe, it, expect } from "vitest";
import { CLEARED_TOOL_RESULT_MARKER } from "@platypus/schemas";
import type { ModelMessage } from "ai";
import {
  applyToolResultClearing,
  clearStaleToolResults,
  clearToolResultsToTarget,
  isClearableToolName,
  observedConversationSize,
  type ClearingPolicy,
} from "./tool-result-clearing.ts";

const toolResultMessage = (
  toolName: string,
  toolCallId: string,
  value: string,
): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output: { type: "text", value },
    },
  ],
});

const userMessage = (text: string): ModelMessage => ({
  role: "user",
  content: text,
});

const POLICY: ClearingPolicy = {
  thresholdFraction: 0.7,
  targetFraction: 0.5,
  keepRecent: 2,
  minBatch: 4,
};

/**
 * A result big enough that clearing it frees substantially more than the
 * marker replacing it. Tiny fixtures hide the whole point of a target rule:
 * clearing a 7-character result frees nothing, so it is deliberately not
 * cleared.
 */
const bigResult = (toolCallId: string, size = 5_000): ModelMessage =>
  toolResultMessage("read_url", toolCallId, "x".repeat(size));

const outputs = (result: ModelMessage[]) =>
  result
    .filter((m) => m.role === "tool")
    .map(
      (m) =>
        (m as { content: Array<{ toolCallId: string; output: unknown }> })
          .content[0],
    );

const clearedIds = (result: ModelMessage[]): string[] =>
  outputs(result)
    .filter(
      (part) =>
        JSON.stringify(part.output) ===
        JSON.stringify({ type: "text", value: CLEARED_TOOL_RESULT_MARKER }),
    )
    .map((part) => part.toolCallId);

describe("isClearableToolName", () => {
  it.each(["web_search", "read_url", "fetchUrl", "fsRead", "fsList"])(
    "allows the core read-only, disposable-result tool %s",
    (name) => {
      expect(isClearableToolName(name)).toBe(true);
    },
  );

  // Denied by default — mutating tools, delegation, and skill loading.
  it.each([
    "fsWrite",
    "fsEdit",
    "shellExec",
    "loadSkill",
    "delegate",
    "delegateToResearchAgent",
    "some_new_tool_nobody_classified_yet",
  ])("denies %s", (name) => {
    expect(isClearableToolName(name)).toBe(false);
  });

  // The MCP read-only hint (ADR-0021, issue #626): a caller-supplied resolver,
  // never a concept this module holds itself.
  describe("with an isReadOnlyTool resolver", () => {
    it("allows a name the resolver reports read-only", () => {
      expect(isClearableToolName("docs__search", () => true)).toBe(true);
    });

    it("denies a name the resolver reports not read-only", () => {
      expect(isClearableToolName("docs__write", () => false)).toBe(false);
    });

    it("still allows the core allowlist even when the resolver denies everything", () => {
      expect(isClearableToolName("web_search", () => false)).toBe(true);
    });

    it("denies everything outside the core allowlist with no resolver given", () => {
      expect(isClearableToolName("docs__search")).toBe(false);
    });
  });
});

describe("clearStaleToolResults", () => {
  it("clears all but the N most recent clearable results", () => {
    const messages: ModelMessage[] = [
      userMessage("go"),
      toolResultMessage("read_url", "t1", "page one content"),
      toolResultMessage("read_url", "t2", "page two content"),
      toolResultMessage("read_url", "t3", "page three content"),
    ];

    const result = clearStaleToolResults(messages, POLICY);

    expect(outputs(result).map((part) => part.output)).toEqual([
      { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      { type: "text", value: "page two content" },
      { type: "text", value: "page three content" },
    ]);
  });

  it("clears everything past keep-recent however small, so the summary pass leaves nothing live", () => {
    // The summary pass calls this with `keepRecent: 0`; it must not adopt the
    // gated rule's "only clear what frees space" posture, because its window is
    // the pass's own input and every clearable result in it is surplus.
    const messages = ["a", "b", "c", "d"].map((id) =>
      toolResultMessage("read_url", id, "tiny"),
    );

    expect(
      clearedIds(clearStaleToolResults(messages, { keepRecent: 0 })),
    ).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the tool call name and id on a cleared result — only content changes", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("read_url", "t1", "content"),
      toolResultMessage("read_url", "t2", "content"),
      toolResultMessage("read_url", "t3", "content"),
    ];

    const [first] = clearStaleToolResults(messages, POLICY);
    const part = (first as { content: Array<Record<string, unknown>> })
      .content[0];
    expect(part.toolCallId).toBe("t1");
    expect(part.toolName).toBe("read_url");
    expect(part.type).toBe("tool-result");
  });

  it("never clears a non-allowlisted tool's result, however many accumulate", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("fsWrite", "w1", "wrote file"),
      toolResultMessage("fsWrite", "w2", "wrote file"),
      toolResultMessage("fsWrite", "w3", "wrote file"),
      toolResultMessage("fsWrite", "w4", "wrote file"),
    ];

    const result = clearStaleToolResults(messages, POLICY);
    expect(result).toBe(messages);
  });

  it("returns the same array reference when nothing is stale", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("read_url", "t1", "content"),
      toolResultMessage("read_url", "t2", "content"),
    ];
    expect(clearStaleToolResults(messages, POLICY)).toBe(messages);
  });

  it("clears an MCP tool's results when the resolver reports it read-only", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("docs__search", "t1", "content"),
      toolResultMessage("docs__search", "t2", "content"),
      toolResultMessage("docs__search", "t3", "content"),
    ];

    const result = clearStaleToolResults(messages, POLICY, () => true);
    expect(clearedIds(result)).toEqual(["t1"]);
  });

  it("never clears an MCP tool's results when the resolver reports it not read-only", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("docs__write", "w1", "wrote"),
      toolResultMessage("docs__write", "w2", "wrote"),
      toolResultMessage("docs__write", "w3", "wrote"),
      toolResultMessage("docs__write", "w4", "wrote"),
    ];

    const result = clearStaleToolResults(messages, POLICY, () => false);
    expect(result).toBe(messages);
  });

  it("counts recency across mixed clearable and non-clearable tool results", () => {
    const messages: ModelMessage[] = [
      toolResultMessage("read_url", "t1", "content"),
      toolResultMessage("fsWrite", "w1", "wrote"),
      toolResultMessage("read_url", "t2", "content"),
      toolResultMessage("read_url", "t3", "content"),
    ];

    const result = clearStaleToolResults(messages, POLICY);
    const readUrlOutputs = outputs(result)
      .filter((part) => part.toolCallId.startsWith("t"))
      .map((part) => part.output);

    expect(readUrlOutputs).toEqual([
      { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      { type: "text", value: "content" },
      { type: "text", value: "content" },
    ]);
  });
});

describe("clearToolResultsToTarget", () => {
  const reading = { occupancy: 700, contextWindow: 1_000 };

  it("clears a batch down to the target fraction rather than every stale result", () => {
    // 50,000 observed characters, 700 of a 1,000-token window: reaching 500
    // means freeing 200/700 of what is sent (about 14,286 characters). Three
    // 5,000-character results would do it; the four-result batch floor clears
    // one more, and the remaining four stale ones stay so the boundary does not
    // have to move again for several steps.
    const messages = Array.from({ length: 10 }, (_, i) => bigResult(`t${i}`));

    const result = clearToolResultsToTarget(messages, reading, POLICY);

    expect(clearedIds(result)).toEqual(["t0", "t1", "t2", "t3"]);
    // Every surviving message is the same object, not a rebuilt equal one.
    result.slice(4).forEach((message, index) => {
      expect(message).toBe(messages[index + 4]);
    });
  });

  it("clears every candidate when the target is out of reach", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      bigResult(`t${i}`, 160),
    );

    expect(
      clearedIds(clearToolResultsToTarget(messages, reading, POLICY)),
    ).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
  });

  it("clears nothing for results no larger than the marker", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      bigResult(`t${i}`, 100),
    );

    expect(clearToolResultsToTarget(messages, reading, POLICY)).toBe(messages);
  });

  it("never clears into the keep-recent window", () => {
    const messages = Array.from({ length: 10 }, (_, i) => bigResult(`t${i}`));

    // Four are protected, so the batch stops before them however large it is.
    expect(
      clearedIds(
        clearToolResultsToTarget(messages, reading, {
          ...POLICY,
          keepRecent: 4,
        }),
      ),
    ).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("leaves the prefix byte-identical across the steps the target buys", () => {
    // One pass at the trigger, then appends that stay below the trigger: the
    // cached prefix survives because no earlier message changes.
    const messages = Array.from({ length: 10 }, (_, i) => bigResult(`t${i}`));
    const pass = clearToolResultsToTarget(messages, reading, POLICY);
    const grown = [...pass, bigResult("t10"), bigResult("t11")];

    expect(
      applyToolResultClearing(
        grown,
        { occupancy: 660, contextWindow: 1_000 },
        POLICY,
      ),
    ).toBe(grown);
  });

  it("moves the boundary again only at the next trigger, leaving cleared results untouched", () => {
    const messages = Array.from({ length: 10 }, (_, i) => bigResult(`t${i}`));
    const pass = clearToolResultsToTarget(messages, reading, POLICY);
    const grown = [...pass, bigResult("t10"), bigResult("t11")];

    const next = applyToolResultClearing(grown, reading, POLICY);

    // The four cleared results keep their exact objects; the next batch starts
    // after them.
    expect(next[0]).toBe(pass[0]);
    expect(next[3]).toBe(pass[3]);
    expect(clearedIds(next)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
    ]);
  });
});

describe("observedConversationSize", () => {
  it("measures text, tool-call inputs and tool-result payloads", () => {
    const messages: ModelMessage[] = [
      userMessage("abc"),
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "read_url",
            input: { url: "https://example.com" },
          },
        ],
      },
      toolResultMessage("read_url", "t1", "hello"),
    ];

    // "abc" (3) + `{"url":"https://example.com"}` (29) + "hello" (5).
    expect(observedConversationSize(messages)).toBe(37);
  });
});

describe("applyToolResultClearing", () => {
  const messages: ModelMessage[] = Array.from({ length: 8 }, (_, i) =>
    bigResult(`t${i}`),
  );

  // Below the threshold — or with either figure unknown, however high the
  // other reads — the messages go out byte-identical.
  it.each([
    [69, 100, false],
    [70, 100, true],
    [95, 100, true],
    [1_000_000, undefined, false],
    [undefined, 100, false],
  ])(
    "at occupancy %s of a %s-token window, clears: %s",
    (occupancy, contextWindow, clears) => {
      const result = applyToolResultClearing(
        messages,
        { occupancy, contextWindow },
        POLICY,
      );

      if (clears) {
        expect(JSON.stringify(result[0])).toContain(CLEARED_TOOL_RESULT_MARKER);
      } else {
        expect(result).toBe(messages);
      }
    },
  );

  it("clears a batch, not one result, once the target rule applies", () => {
    const many = Array.from({ length: 10 }, (_, i) => bigResult(`t${i}`));

    expect(
      clearedIds(
        applyToolResultClearing(
          many,
          { occupancy: 700, contextWindow: 1_000 },
          { ...POLICY, keepRecent: 4 },
        ),
      ),
    ).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("waits for a batch rather than clearing one result at a time", () => {
    // Only one result has become stale, and clearing it cannot reach the
    // target: the pass holds off so the same boundary does not move again on
    // the next step.
    const oneStale = Array.from({ length: 5 }, (_, i) => bigResult(`t${i}`));
    expect(
      clearToolResultsToTarget(
        oneStale,
        { occupancy: 700, contextWindow: 1_000 },
        { ...POLICY, keepRecent: 4 },
      ),
    ).toBe(oneStale);
  });

  it("passes isReadOnlyTool through to the underlying clearing pass", () => {
    const mcpMessages: ModelMessage[] = Array.from({ length: 8 }, (_, i) =>
      toolResultMessage("docs__search", `t${i}`, "x".repeat(5_000)),
    );

    const result = applyToolResultClearing(
      mcpMessages,
      { occupancy: 95, contextWindow: 100 },
      POLICY,
      () => true,
    );
    expect(JSON.stringify(result[0])).toContain(CLEARED_TOOL_RESULT_MARKER);
  });

  it("returns the same array once every stale result is cleared", () => {
    const clearedAll = clearStaleToolResults(messages, { keepRecent: 0 });
    expect(
      applyToolResultClearing(
        clearedAll,
        { occupancy: 95, contextWindow: 100 },
        POLICY,
      ),
    ).toBe(clearedAll);
  });
});
