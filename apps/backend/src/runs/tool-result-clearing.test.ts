import { describe, it, expect } from "vitest";
import {
  CLEARED_TOOL_RESULT_MARKER,
  TOOL_CLEARING_BATCH,
} from "@platypus/schemas";
import type { ModelMessage } from "ai";
import {
  applyToolResultClearing,
  clearStaleToolResults,
  isClearableToolName,
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

const POLICY: ClearingPolicy = {
  thresholdFraction: 0.7,
  keepRecent: 4,
  batchSize: TOOL_CLEARING_BATCH,
};

/** The summary pass and any other caller clearing everything it is given. */
const SUMMARY_POLICY = { keepRecent: 0, batchSize: POLICY.batchSize };

const bigResult = (toolCallId: string, size = 5_000): ModelMessage =>
  toolResultMessage("read_url", toolCallId, "x".repeat(size));

const results = (n: number, prefix = "t"): ModelMessage[] =>
  Array.from({ length: n }, (_, i) => bigResult(`${prefix}${i}`));

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
  it("clears the batched prefix, leaving the keep-recent tail", () => {
    const messages = results(8);

    const result = clearStaleToolResults(messages, POLICY);

    // floor((8 - 4) / 4) * 4 = 4.
    expect(clearedIds(result)).toEqual(["t0", "t1", "t2", "t3"]);
    result.slice(4).forEach((message, index) => {
      expect(message).toBe(messages[index + 4]);
    });
  });

  it("clears everything when keep-recent is zero, so the summary pass leaves nothing live", () => {
    // The summary pass calls this with `keepRecent: 0`; it must not adopt the
    // batched boundary's "wait for a whole batch" posture, because its window
    // is the pass's own input and every clearable result in it is surplus.
    const messages = ["a", "b", "c", "d", "e"].map((id) =>
      toolResultMessage("read_url", id, "tiny"),
    );

    expect(clearedIds(clearStaleToolResults(messages, SUMMARY_POLICY))).toEqual(
      ["a", "b", "c", "d", "e"],
    );
  });

  it("keeps the tool call name and id on a cleared result — only content changes", () => {
    const messages = results(8);

    const [first] = clearStaleToolResults(messages, POLICY);
    const part = (first as { content: Array<Record<string, unknown>> })
      .content[0];
    expect(part.toolCallId).toBe("t0");
    expect(part.toolName).toBe("read_url");
    expect(part.type).toBe("tool-result");
  });

  it("never clears a non-allowlisted tool's result, however many accumulate", () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      toolResultMessage("fsWrite", `w${i}`, "wrote file"),
    );

    expect(clearStaleToolResults(messages, POLICY)).toBe(messages);
  });

  it("returns the same array reference while fewer than a batch are stale", () => {
    // keepRecent + batchSize - 1 stay live: no earlier message changes.
    const messages = results(7);
    expect(clearStaleToolResults(messages, POLICY)).toBe(messages);
  });

  it("clears an MCP tool's results when the resolver reports it read-only", () => {
    const messages = Array.from({ length: 8 }, (_, i) =>
      toolResultMessage("docs__search", `t${i}`, "content"),
    );

    const result = clearStaleToolResults(messages, POLICY, () => true);
    expect(clearedIds(result)).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("never clears an MCP tool's results when the resolver reports it not read-only", () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      toolResultMessage("docs__write", `w${i}`, "wrote"),
    );

    expect(clearStaleToolResults(messages, POLICY, () => false)).toBe(messages);
  });

  it("counts recency across mixed clearable and non-clearable tool results", () => {
    const messages = results(8);
    messages.splice(2, 0, toolResultMessage("fsWrite", "w1", "wrote"));

    const result = clearStaleToolResults(messages, POLICY);
    const readUrlOutputs = outputs(result)
      .filter((part) => part.toolCallId.startsWith("t"))
      .map((part) => part.output);

    expect(readUrlOutputs).toEqual([
      { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      { type: "text", value: "x".repeat(5_000) },
      { type: "text", value: "x".repeat(5_000) },
      { type: "text", value: "x".repeat(5_000) },
      { type: "text", value: "x".repeat(5_000) },
    ]);
  });
});

describe("applyToolResultClearing", () => {
  // Below the threshold with nothing engaged earlier — or with either figure
  // unknown, however high the other reads — the messages go out byte-identical.
  it.each([
    [69, 100, false],
    [70, 100, true],
    [95, 100, true],
    [1_000_000, undefined, false],
    [undefined, 100, false],
  ])(
    "at occupancy %s of a %s-token window, clears: %s",
    (occupancy, contextWindow, clears) => {
      const messages = results(8);
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

  it("keeps clearing when an earlier reading on the path crossed the trigger", () => {
    // The flip-flop: an earlier turn crossed 0.7 and its pass cleared the
    // oldest results, so the latest reading — taken with them cleared — is
    // back below 0.7. Gating on the latest reading alone re-sends everything.
    const messages = results(8);

    expect(
      clearedIds(
        applyToolResultClearing(
          messages,
          {
            occupancy: 620,
            contextWindow: 1_000,
            priorReadings: [
              { inputTokens: 900, outputTokens: 20 },
              { inputTokens: 600, outputTokens: 20 },
            ],
          },
          POLICY,
        ),
      ),
    ).toEqual(["t0", "t1", "t2", "t3"]);
  });

  it("does not engage below the trigger without a qualifying earlier reading", () => {
    const messages = results(8);
    expect(
      applyToolResultClearing(
        messages,
        {
          occupancy: 620,
          contextWindow: 1_000,
          priorReadings: [{ inputTokens: 600, outputTokens: 20 }, null],
        },
        POLICY,
      ),
    ).toBe(messages);
  });

  it("passes isReadOnlyTool through to the underlying clearing pass", () => {
    const mcpMessages = Array.from({ length: 8 }, (_, i) =>
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

  it("returns the same array once every clearable result is already cleared", () => {
    const messages = results(8);
    const clearedAll = clearStaleToolResults(messages, SUMMARY_POLICY);
    expect(
      applyToolResultClearing(
        clearedAll,
        { occupancy: 95, contextWindow: 100 },
        POLICY,
      ),
    ).toBe(clearedAll);
  });
});

describe("batched boundary", () => {
  const pass = (messages: ModelMessage[]) =>
    applyToolResultClearing(
      messages,
      { occupancy: 95, contextWindow: 100 },
      POLICY,
    );

  it("leaves every earlier message byte-identical until the next full batch arrives", () => {
    let grown = pass(results(8));
    expect(clearedIds(grown)).toEqual(["t0", "t1", "t2", "t3"]);

    // Up to B - 1 appends: the boundary does not move, so the same call returns
    // the array untouched and every message keeps its identity.
    for (let added = 1; added < POLICY.batchSize; added += 1) {
      grown = [...grown, bigResult(`t${7 + added}`)];
      expect(pass(grown)).toBe(grown);
    }
  });

  it("moves the boundary by exactly one batch on the Bth append", () => {
    let grown = pass(results(8));
    for (let added = 1; added < POLICY.batchSize; added += 1) {
      grown = [...grown, bigResult(`t${7 + added}`)];
    }
    const before = grown;
    const next = [...grown, bigResult("t11")];

    const after = pass(next);

    // The four cleared results keep their exact objects; the next batch is
    // exactly four more, and the newest four stay live.
    before.slice(0, 4).forEach((message, index) => {
      expect(after[index]).toBe(message);
    });
    expect(clearedIds(after)).toEqual([
      "t0",
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
    ]);
    after.slice(8).forEach((message, index) => {
      expect(message).toBe(next[index + 8]);
    });
  });

  it("clears a whole batch, not every stale result", () => {
    expect(clearedIds(pass(results(10)))).toEqual(["t0", "t1", "t2", "t3"]);
  });
});
