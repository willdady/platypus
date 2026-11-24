import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import { z } from "zod";

import { ABORT_GRACE_MS, startRun } from "./run-lifecycle.ts";
import { driveOnce } from "./drive.ts";
import { RunEventRecorder } from "./run-events.ts";
import { runRegistry, type RunHandle } from "./run-registry.ts";
import { wrapToolsWithActivity } from "../services/tool-activity.ts";
import {
  createDelegateTool,
  createSubAgentDelegate,
  type SubAgentDelegate,
} from "../tools/sub-agent.ts";
import { DELEGATE_TOOL_NAME } from "../tools/turn-tool-names.ts";
import { workspaceScope, orgScope, type WorkspaceScope } from "../scope.ts";
import type { ParentRunContext, RunStats, RunStatus } from "./types.ts";
import { DEFAULT_AGENT_MAX_STEPS } from "@platypus/schemas";
import { TEST_USAGE_MODEL } from "./run-plan.test-fixtures.ts";

const GATE_SCOPE = {
  orgId: "org-1",
  workspaceId: "ws-1",
  attended: false,
  toolSetIds: new Map<string, string>(),
  readOnlyHints: new Map<string, "read-only" | "writes">(),
};

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
        stream: convertArrayToReadableStream(parts),
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

const PER_STEP_MS = 60;
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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not trip the parent's per-step stall timeout", async () => {
    const parent = startParent();

    const delegate = createSubAgentDelegate({
      id: "sa-1",
      name: "Slow Agent",
      plan: {
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
        usageModel: TEST_USAGE_MODEL,
        maxSteps: DEFAULT_AGENT_MAX_STEPS,
      },
      loadTools: () =>
        Promise.resolve({
          tools: {
            slowWork: {
              inputSchema: z.object({}),
              execute: async () => {
                await sleep(SUB_AGENT_MS);
                return "done";
              },
            },
          },
          readOnlyToolNames: new Set(),
          gateScope: GATE_SCOPE,
        }),
      parentRun: {
        runId: "parent",
        scope: parentScope,
        setDelegateUsage: parent.setDelegateUsage,
      },
    });

    const wrapped = wrapToolsWithActivity(
      { [DELEGATE_TOOL_NAME]: createDelegateTool([delegate]) },
      parent.onActivity,
    );

    const execute = (
      wrapped[DELEGATE_TOOL_NAME] as unknown as {
        execute: (a: unknown, o: unknown) => AsyncIterable<unknown>;
      }
    ).execute;

    const drained = (async () => {
      for await (const _ of execute(
        { subAgent: "Slow Agent", task: "Take your time" },
        { abortSignal: parent.handle.signal },
      )) {
        void _;
      }
    })();
    await vi.advanceTimersByTimeAsync(SUB_AGENT_MS);
    await drained;

    expect(parent.handle.signal.aborted).toBe(false);
    expect(outcomes).toEqual([]);

    await parent.finish("succeeded");
    expect(outcomes).toEqual([{ status: "succeeded", error: undefined }]);
  });

  it("still stalls a parent that is idle for the same span", async () => {
    startParent();

    await vi.advanceTimersByTimeAsync(PER_STEP_MS * 2 + ABORT_GRACE_MS);

    expect(parentHandle.signal.aborted).toBe(true);
    expect(outcomes.map((o) => o.status)).toEqual(["failed"]);
    expect(outcomes[0].error?.name).toBe("TimeoutError");
  });

  it("registers the delegated run for its duration and unregisters it after", async () => {
    const parent = startParent();
    const registerSpy = vi.spyOn(runRegistry, "register");

    const delegate = createSubAgentDelegate({
      id: "sa-1",
      name: "Quick Agent",
      plan: {
        model: modelOf(
          stream([
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Done." },
            { type: "text-end", id: "t1" },
          ]),
        ),
        usageModel: TEST_USAGE_MODEL,
        maxSteps: DEFAULT_AGENT_MAX_STEPS,
      },
      loadTools: () =>
        Promise.resolve({
          tools: {},
          readOnlyToolNames: new Set(),
          gateScope: GATE_SCOPE,
        }),
      parentRun: {
        runId: "parent",
        scope: parentScope,
        setDelegateUsage: parent.setDelegateUsage,
      },
    });

    const gen = (
      createDelegateTool([delegate]) as unknown as {
        execute: (a: unknown, o: unknown) => AsyncIterable<unknown>;
      }
    ).execute(
      { subAgent: "Quick Agent", task: "Be quick" },
      { abortSignal: parent.handle.signal },
    );

    let subRunId: string | undefined;
    for await (const _ of gen) {
      void _;
      if (subRunId) continue;
      subRunId = registerSpy.mock.calls.at(-1)?.[0];
      expect(runRegistry.has(subRunId!)).toBe(true);
    }

    expect(subRunId).toMatch(/^sub_/);
    expect(runRegistry.has(subRunId!)).toBe(false);

    registerSpy.mockRestore();
    await parent.finish("succeeded");
  });
});
describe("a delegated run's Run events", () => {
  const delegateCall = (
    id: string,
    subAgent: string,
  ): LanguageModelV3StreamPart[] => [
    { type: "tool-input-start", id, toolName: DELEGATE_TOOL_NAME },
    { type: "tool-input-end", id },
    {
      type: "tool-call",
      toolCallId: id,
      toolName: DELEGATE_TOOL_NAME,
      input: JSON.stringify({ subAgent, task: `Task for ${subAgent}` }),
    },
  ];

  const workingDelegate = (
    id: string,
    name: string,
    setDelegateUsage: ParentRunContext["setDelegateUsage"] = () => undefined,
  ) =>
    createSubAgentDelegate({
      id,
      name,
      plan: {
        model: modelOf(
          stream(
            [
              { type: "tool-input-start", id: "w1", toolName: "work" },
              { type: "tool-input-end", id: "w1" },
              {
                type: "tool-call",
                toolCallId: "w1",
                toolName: "work",
                input: "{}",
              },
            ],
            "tool-calls",
          ),
          stream([
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: `${name} done.` },
            { type: "text-end", id: "t1" },
          ]),
        ),
        usageModel: TEST_USAGE_MODEL,
        maxSteps: DEFAULT_AGENT_MAX_STEPS,
      },
      loadTools: () =>
        Promise.resolve({
          tools: {
            work: {
              inputSchema: z.object({}),
              execute: async () => {
                await sleep(15);
                return "worked";
              },
            },
          },
          readOnlyToolNames: new Set(),
          gateScope: GATE_SCOPE,
        }),
      parentRun: { runId: "parent", scope: parentScope, setDelegateUsage },
    });

  it("nests the delegate's events beneath the parent's delegate event, and loses none across parallel delegates", async () => {
    const outcomes: RunStatus[] = [];
    const parent = startRun({
      runId: `parent-${Math.random().toString(36).slice(2)}`,
      onTerminate: ({ status }) => {
        outcomes.push(status);
      },
    });
    const events = new RunEventRecorder({ runId: parent.handle.runId });

    const tool = createDelegateTool([
      workingDelegate("sa-a", "Alpha"),
      workingDelegate("sa-b", "Beta"),
    ]);

    await driveOnce({
      plan: {
        model: modelOf(
          stream(
            [...delegateCall("d1", "Alpha"), ...delegateCall("d2", "Beta")],
            "tool-calls",
          ),
          stream([
            { type: "text-start", id: "p1" },
            { type: "text-delta", id: "p1", delta: "Both done." },
            { type: "text-end", id: "p1" },
          ]),
        ),
        tools: wrapToolsWithActivity(
          { [DELEGATE_TOOL_NAME]: tool },
          parent.onActivity,
        ),
        usageModel: TEST_USAGE_MODEL,
        maxSteps: 3,
      },
      run: parent,
      prompt: "Fan out",
      events,
    });

    expect(outcomes).toEqual(["succeeded"]);

    const delegates = events.events.filter((e) => e.type === "delegate");
    expect(delegates.map((d) => [d.toolName, d.status])).toEqual([
      ["Alpha", "completed"],
      ["Beta", "completed"],
    ]);

    for (const delegate of delegates) {
      const children = events.events.filter(
        (e) => e.parentEventId === delegate.id,
      );
      expect(children.map((c) => [c.type, c.toolName, c.status])).toEqual([
        ["tool-input", "work", "completed"],
        ["tool-call", "work", "completed"],
        ["text", null, "completed"],
      ]);
      for (const child of children) {
        expect(child.startedAt).toBeGreaterThanOrEqual(delegate.startedAt);
      }
    }
    const rootEvents = events.events.filter((e) => e.parentEventId === null);
    expect(rootEvents.map((e) => [e.type, e.toolName])).toEqual([
      ["tool-input", DELEGATE_TOOL_NAME],
      ["delegate", "Alpha"],
      ["tool-input", DELEGATE_TOOL_NAME],
      ["delegate", "Beta"],
      ["text", null],
    ]);

    const serialized = JSON.stringify(events.events);
    expect(serialized).not.toContain("Task for");
    expect(serialized).not.toContain("worked");
    expect(serialized).not.toContain("done.");
  });
});

describe("a delegated run's Token usage", () => {
  const PARENT = { providerId: "p-parent", model: "big" };
  const CHILD = { providerId: "p-child", model: "small" };

  const delegateCall = (id: string, subAgent: string) => [
    { type: "tool-input-start" as const, id, toolName: DELEGATE_TOOL_NAME },
    { type: "tool-input-end" as const, id },
    {
      type: "tool-call" as const,
      toolCallId: id,
      toolName: DELEGATE_TOOL_NAME,
      input: JSON.stringify({ subAgent, task: "Go" }),
    },
  ];

  const delegateOf = (
    name: string,
    parentRun: ParentRunContext,
    workMs: number[],
  ) => {
    let call = 0;
    return createSubAgentDelegate({
      id: `sa-${name}`,
      name,
      plan: {
        model: modelOf(
          ...workMs.map(() =>
            stream(
              [
                { type: "tool-input-start", id: "w1", toolName: "work" },
                { type: "tool-input-end", id: "w1" },
                {
                  type: "tool-call",
                  toolCallId: "w1",
                  toolName: "work",
                  input: "{}",
                },
              ],
              "tool-calls",
            ),
          ),
          stream([
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Done." },
            { type: "text-end", id: "t1" },
          ]),
        ),
        usageModel: CHILD,
        maxSteps: DEFAULT_AGENT_MAX_STEPS,
      },
      loadTools: () =>
        Promise.resolve({
          tools: {
            work: {
              inputSchema: z.object({}),
              execute: async () => {
                await sleep(workMs[call++]);
                return "worked";
              },
            },
          },
          readOnlyToolNames: new Set(),
          gateScope: GATE_SCOPE,
        }),
      parentRun,
    });
  };

  const runParent = async (
    names: string[],
    delegateFor: (
      name: string,
      parentRun: ParentRunContext,
    ) => SubAgentDelegate,
    cancelAfterMs?: number,
  ) => {
    let reported: RunStats | undefined;
    const parent = startRun({
      runId: `parent-${Math.random().toString(36).slice(2)}`,
      onTerminate: ({ stats }) => {
        reported = stats;
      },
    });
    const parentRun: ParentRunContext = {
      runId: parent.handle.runId,
      scope: parentScope,
      setDelegateUsage: parent.setDelegateUsage,
    };
    if (cancelAfterMs !== undefined) {
      await parent.adoptOrDispose(() => Promise.resolve());
      setTimeout(() => runRegistry.cancel(parent.handle.runId), cancelAfterMs);
    }
    const tool = createDelegateTool(
      names.map((name) => delegateFor(name, parentRun)),
    );
    await driveOnce({
      plan: {
        model: modelOf(
          stream(
            names.flatMap((name, i) => delegateCall(`d${i}`, name)),
            "tool-calls",
          ),
          stream([
            { type: "text-start", id: "p1" },
            { type: "text-delta", id: "p1", delta: "All done." },
            { type: "text-end", id: "p1" },
          ]),
        ),
        usageModel: PARENT,
        tools: wrapToolsWithActivity(
          { [DELEGATE_TOOL_NAME]: tool },
          parent.onActivity,
        ),
        maxSteps: 3,
      },
      run: parent,
      prompt: "Fan out",
    }).catch(() => undefined);
    return reported;
  };

  it("folds parallel delegates into the parent's sums, broken down by model", async () => {
    const reported = await runParent(["Alpha", "Beta"], (name, parentRun) =>
      delegateOf(name, parentRun, [15]),
    );

    expect(reported).toMatchObject({
      inputTokens: 30,
      outputTokens: 12,
      usageByModel: [
        { ...PARENT, inputTokens: 10, outputTokens: 4 },
        { ...CHILD, inputTokens: 20, outputTokens: 8 },
      ],
    });
    expect(reported?.contextOccupancy).toBe(5);
  });

  it("counts what a timed-out delegate was billed before it stopped", async () => {
    const reported = await runParent(["Alpha", "Slow"], (name, parentRun) =>
      name === "Slow"
        ? delegateOf(
            name,
            {
              ...parentRun,
              timeouts: { perStepTimeoutMs: 60_000, perRunTimeoutMs: 60 },
            },
            [15, 500],
          )
        : delegateOf(name, parentRun, [15]),
    );

    expect(reported?.usageByModel).toEqual([
      { ...PARENT, inputTokens: 10, outputTokens: 4 },
      { ...CHILD, inputTokens: 15, outputTokens: 6 },
    ]);
  });

  it("counts a delegate cancelled along with its parent", async () => {
    const reported = await runParent(
      ["Slow"],
      (name, parentRun) => delegateOf(name, parentRun, [15, 500]),
      100,
    );

    expect(reported?.usageByModel).toEqual([
      { ...CHILD, inputTokens: 5, outputTokens: 2 },
    ]);
  });
});
