import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  applyToolResultClearing,
  clearStaleToolResults,
  CLEARED_TOOL_RESULT_MARKER,
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

const userMessage = (text: string): ModelMessage => ({
  role: "user",
  content: text,
});

const POLICY: ClearingPolicy = { thresholdFraction: 0.7, keepRecent: 2 };

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

    const contents = result
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: unknown[] }).content[0]);
    expect(contents).toEqual([
      expect.objectContaining({
        toolCallId: "t1",
        output: { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      }),
      expect.objectContaining({
        toolCallId: "t2",
        output: { type: "text", value: "page two content" },
      }),
      expect.objectContaining({
        toolCallId: "t3",
        output: { type: "text", value: "page three content" },
      }),
    ]);
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
    const contents = result
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: unknown[] }).content[0]);
    expect(contents).toEqual([
      expect.objectContaining({
        toolCallId: "t1",
        output: { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      }),
      expect.objectContaining({ toolCallId: "t2" }),
      expect.objectContaining({ toolCallId: "t3" }),
    ]);
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
    const readUrlOutputs = result
      .filter((m) => m.role === "tool")
      .map((m) => (m as { content: Array<Record<string, unknown>> }).content[0])
      .filter((p) => p.toolName === "read_url")
      .map((p) => p.output);

    expect(readUrlOutputs).toEqual([
      { type: "text", value: CLEARED_TOOL_RESULT_MARKER },
      { type: "text", value: "content" },
      { type: "text", value: "content" },
    ]);
  });
});

describe("applyToolResultClearing", () => {
  const messages: ModelMessage[] = [
    toolResultMessage("read_url", "t1", "content"),
    toolResultMessage("read_url", "t2", "content"),
    toolResultMessage("read_url", "t3", "content"),
  ];

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

  it("passes isReadOnlyTool through to the underlying clearing pass", () => {
    const mcpMessages: ModelMessage[] = [
      toolResultMessage("docs__search", "t1", "content"),
      toolResultMessage("docs__search", "t2", "content"),
      toolResultMessage("docs__search", "t3", "content"),
    ];

    const result = applyToolResultClearing(
      mcpMessages,
      { occupancy: 95, contextWindow: 100 },
      POLICY,
      () => true,
    );
    expect(JSON.stringify(result[0])).toContain(CLEARED_TOOL_RESULT_MARKER);
  });
});
