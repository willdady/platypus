import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { startRun } from "./run-lifecycle.ts";
import { runRegistry, type RunHandle } from "./run-registry.ts";
import { wrapToolsWithActivity } from "../services/tool-activity.ts";
import { createSubAgentTool } from "../tools/sub-agent.ts";
import { workspaceScope, orgScope, type WorkspaceScope } from "../scope.ts";
import type { RunStatus } from "./types.ts";

/**
 * A parent turn and the delegate tool it advertises, composed the way
 * `prepareChatTurn` composes them.
 *
 * Never composed in a test before this: the per-step stall timer lives in
 * `runs/`, the tool wrapper in `services/`, and the delegate in `tools/`, so
 * "does a long delegation kill the parent?" had no home to be asked in.
 */
const USAGE = {
  inputTokens: {
    total: 5,
    noCache: 5,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 2, text: 2, reasoning: undefined },
};

const stream = (
  parts: LanguageModelV3StreamPart[],
  unified: "stop" | "tool-calls" = "stop",
): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  ...parts,
  { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE },
];

const modelOf = (...steps: LanguageModelV3StreamPart[][]) => {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: () => {
      const parts = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return Promise.resolve({
        stream: simulateReadableStream({ chunks: parts }),
      });
    },
  });
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const parentScope: WorkspaceScope = workspaceScope(
  orgScope({ principal: { kind: "user", userId: "u1", name: "Ada" } }, "org-1"),
  "ws-1",
  true,
);

/** The parent's stall threshold. Small enough to fire inside a fast test. */
const PER_STEP_MS = 60;
/** How long the delegated run takes — several times the parent's threshold. */
const SUB_AGENT_MS = 250;

describe("a delegated run inside a parent run", () => {
  let outcomes: Array<{ status: RunStatus; error?: Error }>;
  let parentHandle: RunHandle;

  const startParent = () => {
    outcomes = [];
    const parent = startRun({
      runId: `parent-${Math.random().toString(36).slice(2)}`,
      timeouts: { perStepTimeoutMs: PER_STEP_MS, perRunTimeoutMs: 60_000 },
      onTerminate: ({ status, error }) => {
        outcomes.push({ status, error });
      },
    });
    parentHandle = parent.handle;
    return parent;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The acceptance criterion: before this, the only thing keeping the parent
  // alive across a long delegation was a 30s heartbeat interval started in
  // `services/` and fed by the sub-agent's own stream yields.
  it("does not trip the parent's per-step stall timeout", async () => {
    const parent = startParent();

    const { toolName, tool } = createSubAgentTool({
      id: "sa-1",
      name: "Slow Agent",
      model: modelOf(
        stream(
          [
            { type: "tool-input-start", id: "tc1", toolName: "slowWork" },
            { type: "tool-input-end", id: "tc1" },
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "slowWork",
              input: "{}",
            },
          ],
          "tool-calls",
        ),
        stream([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Took a while." },
          { type: "text-end", id: "t1" },
        ]),
      ),
      tools: {
        slowWork: {
          inputSchema: z.object({}),
          execute: async () => {
            await sleep(SUB_AGENT_MS);
            return "done";
          },
        },
      },
      parentRun: { runId: "parent", scope: parentScope },
    });

    // Exactly what `prepareChatTurn` hands the model: the delegate wrapped so
    // its boundaries reach the parent's run lifecycle.
    const wrapped = wrapToolsWithActivity(
      { [toolName]: tool },
      parent.onActivity,
    );

    const execute = (
      wrapped[toolName] as unknown as {
        execute: (a: unknown, o: unknown) => AsyncIterable<unknown>;
      }
    ).execute;

    for await (const _ of execute(
      { task: "Take your time" },
      { abortSignal: parent.handle.signal },
    )) {
      void _;
    }

    expect(parent.handle.signal.aborted).toBe(false);
    expect(outcomes).toEqual([]);

    await parent.finish("succeeded");
    expect(outcomes).toEqual([{ status: "succeeded", error: undefined }]);
  });

  // Proves the threshold above is real: the same wait with no tool call in
  // flight does end the parent run.
  it("still stalls a parent that is idle for the same span", async () => {
    startParent();

    await sleep(PER_STEP_MS * 2);

    expect(parentHandle.signal.aborted).toBe(true);
    expect(outcomes.map((o) => o.status)).toEqual(["failed"]);
    expect(outcomes[0].error?.name).toBe("TimeoutError");
  });

  it("registers the delegated run for its duration and unregisters it after", async () => {
    const parent = startParent();
    const registerSpy = vi.spyOn(runRegistry, "register");

    const { tool } = createSubAgentTool({
      id: "sa-1",
      name: "Quick Agent",
      model: modelOf(
        stream([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Done." },
          { type: "text-end", id: "t1" },
        ]),
      ),
      tools: {},
      parentRun: { runId: "parent", scope: parentScope },
    });

    const gen = (
      tool as unknown as {
        execute: (a: unknown, o: unknown) => AsyncIterable<unknown>;
      }
    ).execute({ task: "Be quick" }, { abortSignal: parent.handle.signal });

    let subRunId: string | undefined;
    for await (const _ of gen) {
      void _;
      if (subRunId) continue;
      subRunId = registerSpy.mock.calls.at(-1)?.[0];
      // Registered from the first activity update, while the delegation is
      // still streaming.
      expect(runRegistry.has(subRunId!)).toBe(true);
    }

    expect(subRunId).toMatch(/^sub_/);
    expect(runRegistry.has(subRunId!)).toBe(false);

    registerSpy.mockRestore();
    await parent.finish("succeeded");
  });
});
