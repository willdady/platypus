import { describe, it, expect } from "vitest";
import type { PlatypusUIMessage } from "@platypus/backend/src/types";
import { clearedToolCallIds } from "./tool-result-clearing";

/**
 * A tool-result message, with `readOnlyToolNames` metadata reporting the tool
 * clearable by default — the shape the backend now reports for the core
 * allowlist and an MCP tool alike (ADR-0021, issue #626). Pass
 * `clearable: false` for a tool no message ever reports.
 */
const toolResultMessage = (
  toolName: string,
  toolCallId: string,
  { clearable = true }: { clearable?: boolean } = {},
): PlatypusUIMessage =>
  ({
    id: `m-${toolCallId}`,
    role: "assistant",
    parts: [
      {
        type: `tool-${toolName}`,
        toolCallId,
        state: "output-available",
        input: {},
        output: { ok: true },
      },
    ],
    metadata: clearable ? { readOnlyToolNames: [toolName] } : undefined,
  }) as unknown as PlatypusUIMessage;

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

  it("marks all but the shared keep-recent count as cleared, at threshold", () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      toolResultMessage("read_url", `t${i}`),
    );
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    // TOOL_RESULT_CLEARING_KEEP_RECENT is 4, so the first two are stale.
    expect(result).toEqual(new Set(["t0", "t1"]));
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
    const messages = Array.from({ length: 6 }, (_, i) =>
      toolResultMessage("docs_search__search", `t${i}`),
    );
    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    expect(result).toEqual(new Set(["t0", "t1"]));
  });

  it("unions clearable names reported across different messages", () => {
    // Only the LAST message's metadata reports `docs_search__search` as
    // clearable; the earlier five carry no metadata of their own. The client
    // holds no clearability policy of its own — it unions whatever the whole
    // Transcript has reported by the time it reads it, so the earlier calls
    // still count.
    const messages: PlatypusUIMessage[] = Array.from({ length: 6 }, (_, i) => ({
      ...toolResultMessage("docs_search__search", `t${i}`),
      metadata: undefined,
    }));
    messages[5] = toolResultMessage("docs_search__search", "t5");

    const result = clearedToolCallIds(messages, {
      occupancy: 95,
      contextWindow: 100,
    });
    expect(result).toEqual(new Set(["t0", "t1"]));
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
