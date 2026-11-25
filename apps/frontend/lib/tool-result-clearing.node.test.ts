import { describe, it, expect } from "vitest";
import type { PlatypusUIMessage } from "@platypus/schemas";
import {
  clearedInputToolCallIds,
  clearedToolCallIds,
} from "./tool-result-clearing";

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
    expect(result).toEqual(new Set(["t0", "t1", "t2", "t3"]));
  });

  it("marks a failed read's result as cleared, as the backend does", () => {
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
    expect(cleared).toEqual(
      new Set(["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"]),
    );
  });

  it("marks a batch of writes below the trigger when an earlier reading engaged", () => {
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
