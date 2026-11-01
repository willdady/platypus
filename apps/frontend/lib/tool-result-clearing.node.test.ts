import { describe, it, expect } from "vitest";
import type { PlatypusUIMessage } from "@platypus/schemas";
import {
  clearedInputToolCallIds,
  clearedToolCallIds,
} from "./tool-result-clearing";

/**
 * A tool-result message, with `readOnlyToolNames` metadata reporting the tool
 * clearable by default — the shape the backend now reports for the core
 * allowlist and an MCP tool alike (ADR-0021, issue #626). Pass
 * `clearable: false` for a tool no message ever reports.
 *
 * The output is deliberately large: clearing replaces it with a fixed marker,
 * and a result no larger than that marker frees nothing, so a tiny fixture
 * would exercise the "clear nothing" branch rather than the batching rule.
 */
function toolResultMessage(
  toolName: string,
  toolCallId: string,
  { clearable = true }: { clearable?: boolean } = {},
): PlatypusUIMessage {
  return {
    id: `m-${toolCallId}`,
    role: "assistant",
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId,
        state: "output-available",
        input: {},
        output: "x".repeat(5_000),
      },
    ],
    metadata: clearable ? { readOnlyToolNames: [toolName] } : undefined,
  } as unknown as PlatypusUIMessage;
}

describe("clearedToolCallIds", () => {
  it("returns nothing when the Context window is unknown", () => {
    const messages = [
      toolResultMessage("read_url", "t1"),
      toolResultMessage("read_url", "t2"),
      toolResultMessage("read_url", "t3"),
      toolResultMessage("read_url", "t4"),
      toolResultMessage("read_url", "t5"),
      toolResultMessage("read_url", "t6"),
    ];
    expect(
      clearedToolCallIds(messages, { occupancy: 95, contextWindow: undefined }),
    ).toEqual(new Set());
  });

  it("returns nothing below the shared threshold", () => {
    const messages = [
      toolResultMessage("read_url", "t1"),
      toolResultMessage("read_url", "t2"),
    ];
    expect(
      clearedToolCallIds(messages, { occupancy: 10, contextWindow: 100 }),
    ).toEqual(new Set());
  });

  it("waits for a batch when only a couple of results are stale", () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      toolResultMessage("read_url", `t${i}`),
    );
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    // TOOL_RESULT_CLEARING_KEEP_RECENT is 4 and the batch floor is 4, so two
    // stale results are not worth the cache invalidation yet.
    expect(result).toEqual(new Set());
  });

  it("marks a target-sized batch rather than every stale result", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      toolResultMessage("read_url", `t${i}`),
    );
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    // Six are stale by count; clearing to the 0.5 target needs five of the
    // 5,000-character results, so the last five stay live.
    expect(result).toEqual(new Set(["t0", "t1", "t2", "t3", "t4"]));
  });

  it("never marks a tool's result as cleared when no message reports it clearable", () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      toolResultMessage("fsWrite", `w${i}`, { clearable: false }),
    );
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    expect(result).toEqual(new Set());
  });

  // ADR-0021, issue #626: an MCP tool is clearable the same way a core one
  // is — reported by name, not looked up against a name list this module no
  // longer holds.
  it("marks an MCP tool's result as cleared when its metadata reports it clearable", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      toolResultMessage("docs_search__search", `t${i}`),
    );
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    expect(result).toEqual(new Set(["t0", "t1", "t2", "t3", "t4"]));
  });

  it("unions clearable names reported across different messages", () => {
    // Only the LAST message's metadata reports `docs_search__search` as
    // clearable; the earlier ones carry no metadata of their own. The client
    // holds no clearability policy of its own — it unions whatever the whole
    // Transcript has reported by the time it reads it, so the earlier calls
    // still count.
    const messages: PlatypusUIMessage[] = Array.from(
      { length: 10 },
      (_, i) => ({
        ...toolResultMessage("docs_search__search", `t${i}`),
        metadata: undefined,
      }),
    );
    messages[9] = toolResultMessage("docs_search__search", "t9");

    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    expect(result).toEqual(new Set(["t0", "t1", "t2", "t3", "t4"]));
  });

  // The transcript memo compares this Set by identity, so "nothing is cleared"
  // has to be one object rather than a fresh empty Set per render (issue #869).
  it("returns the same empty set identity whenever nothing is cleared", () => {
    const messages = [toolResultMessage("read_url", "t1")];
    const unknown = clearedToolCallIds(messages, {
      occupancy: undefined,
      contextWindow: undefined,
    });
    const belowThreshold = clearedToolCallIds(messages, {
      occupancy: 10,
      contextWindow: 100,
    });
    const nothingStale = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });

    expect(unknown).toBe(belowThreshold);
    expect(nothingStale).toBe(unknown);
  });

  it("ignores a clearable tool call that hasn't produced its result yet", () => {
    const inFlight = {
      id: "m-x",
      role: "assistant",
      parts: [
        {
          type: "tool-read_url",
          toolCallId: "x1",
          state: "input-available",
        },
      ],
      metadata: { readOnlyToolNames: ["read_url"] },
    } as unknown as PlatypusUIMessage;

    const messages = [
      ...Array.from({ length: 6 }, (_, i) =>
        toolResultMessage("read_url", `t${i}`),
      ),
      inFlight,
    ];
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    expect(result.has("x1")).toBe(false);
  });
});

describe("clearedInputToolCallIds", () => {
  const write = (
    toolCallId: string,
    {
      state = "output-available",
      output = { ok: true },
      toolName = "fsWrite",
    }: { state?: string; output?: unknown; toolName?: string } = {},
  ): PlatypusUIMessage =>
    ({
      id: `m-${toolCallId}`,
      role: "assistant",
      parts: [
        {
          type: `tool-${toolName}`,
          toolCallId,
          state,
          input: { path: "f", content: "c".repeat(1_400), mode: "create" },
          output,
        },
      ],
    }) as unknown as PlatypusUIMessage;

  const ABOVE = { occupancy: 95, contextWindow: 100 };

  it("marks a target-sized batch of writes rather than every stale one", () => {
    const messages = Array.from({ length: 12 }, (_, i) => write(`w${i}`));
    const cleared = clearedInputToolCallIds(messages, ABOVE);
    // Eight are stale by count; the target stops the batch before the end.
    expect(cleared.size).toBeGreaterThan(1);
    expect(cleared.size).toBeLessThan(8);
    expect(messages.slice(0, cleared.size).map((m) => m.id)).toEqual(
      [...cleared].map((id) => `m-${id}`),
    );
  });

  it("skips a failed call and an `{ error }` result", () => {
    const messages = [
      write("e0", { state: "output-error", output: undefined }),
      write("e1", { output: { error: "nope" } }),
      ...Array.from({ length: 4 }, (_, i) => write(`w${i}`)),
    ];
    expect(clearedInputToolCallIds(messages, ABOVE).size).toBe(0);
  });

  it("never marks a tool outside the allowlist", () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      write(`m${i}`, { toolName: "shellExec" }),
    );
    expect(clearedInputToolCallIds(messages, ABOVE).size).toBe(0);
  });

  it("returns the same empty set when nothing is cleared (issue #869)", () => {
    const messages = [write("w0")];
    expect(clearedInputToolCallIds(messages, {})).toBe(
      clearedInputToolCallIds(messages, ABOVE),
    );
  });
});
