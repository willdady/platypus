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

/** An assistant message that carries a Context occupancy reading, and no tool parts. */
function readingMessage(
  id: string,
  inputTokens: number,
  outputTokens = 0,
): PlatypusUIMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "text", text: "done" }],
    metadata: { contextOccupancy: { inputTokens, outputTokens } },
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

  it("stays engaged when an earlier reading on the path crossed the trigger", () => {
    // The flip-flop: the earlier turn crossed 0.7 and a pass cleared the oldest
    // results, so the latest reading — taken with them cleared — is back below
    // 0.7. Gating on the latest reading alone would re-send everything this
    // turn, then clear again the turn after.
    const messages = [
      readingMessage("r-high", 900, 20),
      ...Array.from({ length: 8 }, (_, i) =>
        toolResultMessage("read_url", `t${i}`),
      ),
      readingMessage("r-low", 600, 20),
    ];

    expect(
      clearedToolCallIds(messages, { occupancy: 620, contextWindow: 1_000 }),
    ).toEqual(new Set(["t0", "t1", "t2", "t3"]));
  });

  it("disengages once the only high reading is gone from the path", () => {
    // Same shape without the earlier high reading: a Delete or an Alternative
    // that removed it leaves nothing that ever crossed the trigger.
    const messages = [
      ...Array.from({ length: 8 }, (_, i) =>
        toolResultMessage("read_url", `t${i}`),
      ),
      readingMessage("r-low", 600, 20),
    ];

    expect(
      clearedToolCallIds(messages, { occupancy: 620, contextWindow: 1_000 }),
    ).toEqual(new Set());
  });

  it("waits for a batch when only a couple of results are stale", () => {
    // A large non-clearable prompt makes the target out of reach with only two
    // stale results; one more 500-character result would not overflow a
    // 100-token window, so the pass waits.
    const bigText = {
      id: "u-big",
      role: "user",
      parts: [{ type: "text", text: "y".repeat(9_000) }],
    } as unknown as PlatypusUIMessage;
    const messages = [
      bigText,
      ...Array.from({ length: 6 }, (_, i) => ({
        ...toolResultMessage("read_url", `t${i}`),
        parts: [
          {
            type: "tool-read_url",
            toolCallId: `t${i}`,
            state: "output-available",
            input: {},
            output: "x".repeat(500),
          },
        ],
      })),
    ] as unknown as PlatypusUIMessage[];
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    expect(result).toEqual(new Set());
  });

  it("marks the oldest whole batch of results", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      toolResultMessage("read_url", `t${i}`),
    );
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    // floor((10 - 4) / 4) * 4 = 4: one batch, not the six stale-by-count.
    expect(result).toEqual(new Set(["t0", "t1", "t2", "t3"]));
  });

  it("marks a failed read's result as cleared, as the backend does", () => {
    // Result clearing is about the tool, not the outcome: an allowlisted read
    // that errored is still a disposable result the backend clears.
    const messages = Array.from({ length: 10 }, (_, i) => ({
      ...toolResultMessage("read_url", `t${i}`),
      parts: [
        {
          type: "tool-read_url",
          toolCallId: `t${i}`,
          state: "output-error",
          input: {},
          errorText: "x".repeat(5_000),
        },
      ],
    })) as unknown as PlatypusUIMessage[];
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    expect(result).toEqual(new Set(["t0", "t1", "t2", "t3"]));
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
    expect(result).toEqual(new Set(["t0", "t1", "t2", "t3"]));
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
    expect(result).toEqual(new Set(["t0", "t1", "t2", "t3"]));
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
    // Eight are stale by count and the 0.4 target reaches all of them.
    expect(cleared).toEqual(
      new Set(["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"]),
    );
  });

  it("marks a batch of writes below the trigger when an earlier reading engaged", () => {
    // The same sticky gate as results: a prior turn crossed 0.7, its pass moved
    // the boundary, and the latest reading fell back under the trigger.
    const messages = [
      readingMessage("r-high", 900, 20),
      ...Array.from({ length: 8 }, (_, i) => write(`w${i}`)),
      readingMessage("r-low", 600, 20),
    ];
    expect(
      clearedInputToolCallIds(messages, {
        occupancy: 620,
        contextWindow: 1_000,
      }),
    ).toEqual(new Set(["w0", "w1", "w2", "w3"]));
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
