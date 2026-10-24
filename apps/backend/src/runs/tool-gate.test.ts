import { afterEach, describe, expect, it } from "vitest";
import { dynamicTool, simulateReadableStream } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import type { ToolGateCall, ToolGateVerdict } from "@platypuschat/plugin-sdk";
import { startRun } from "./run-lifecycle.ts";
import { driveChat, driveDelegate, driveOnce } from "./drive.ts";
import { buildModelInvocation, type RunPlan } from "./run-plan.ts";
import { RunEventRecorder } from "./run-events.ts";
import type { RunStatus } from "./types.ts";
import {
  clearToolGates,
  registerToolGate,
  type ToolGateScope,
} from "../tool-gates/index.ts";

/**
 * The Tool gate (ADR-0033) at the seam all three Drives share: a real AI SDK
 * pipeline, a mock model that calls one tool and then answers, and gates
 * registered the way the plugin loader registers them.
 */

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

const step = (
  parts: LanguageModelV3StreamPart[],
  unified: "stop" | "tool-calls" = "stop",
): LanguageModelV3StreamPart[] => [
  { type: "stream-start", warnings: [] },
  ...parts,
  { type: "finish", finishReason: { unified, raw: unified }, usage: USAGE },
];

const toolCallStep = (id: string, input = { path: "/data" }) =>
  step(
    [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "wipe",
        input: JSON.stringify(input),
      },
    ],
    "tool-calls",
  );

const answerStep = step([
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "done" },
  { type: "text-end", id: "t1" },
]);

/** Calls `wipe` once, then answers. Keeps every prompt it was sent. */
const callThenAnswer = () => {
  const prompts: unknown[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doStream: (options) => {
      prompts.push(options.prompt);
      const parts = index === 0 ? toolCallStep("tc1") : answerStep;
      index += 1;
      return Promise.resolve({
        stream: simulateReadableStream({ chunks: parts }),
      });
    },
  });
  return { model, prompts };
};

/** Calls `wipe` with the same arguments on every step, forever. */
const callForever = () => {
  let index = 0;
  return new MockLanguageModelV3({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({
          chunks: toolCallStep(`tc${(index += 1)}`),
        }),
      }),
  });
};

const SCOPE: ToolGateScope = {
  orgId: "org-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  attended: false,
  toolSetIds: new Map([["wipe", "files"]]),
  readOnlyHints: new Map(),
};

const planWith = (
  model: MockLanguageModelV3,
  executed: string[],
  gateScope: ToolGateScope | undefined = SCOPE,
): RunPlan => ({
  model,
  maxSteps: 12,
  gateScope,
  tools: {
    wipe: {
      description: "Delete a directory.",
      inputSchema: z.object({ path: z.string() }),
      execute: ({ path }: { path: string }) => {
        executed.push(path);
        return "wiped";
      },
    },
  },
});

const startRecordedRun = () => {
  const outcome: Array<{ status: RunStatus; error?: Error }> = [];
  const run = startRun({
    runId: `gate-${Math.random().toString(36).slice(2)}`,
    onTerminate: ({ status, error }) => {
      outcome.push({ status, error });
    },
  });
  return { run, outcome };
};

/** Registers a gate that answers `verdict` and records every call it saw. */
const gate = (
  id: string,
  answer: (call: ToolGateCall) => ToolGateVerdict | Promise<ToolGateVerdict>,
  timeoutMs = 1_000,
) => {
  const seen: ToolGateCall[] = [];
  registerToolGate({
    id,
    name: id,
    timeoutMs,
    evaluate: (call) => {
      seen.push(call);
      return answer(call);
    },
  });
  return seen;
};

/** The tool-result part the model was sent for `tc1` on its second call. */
const toolResultSentBack = (prompts: unknown[]) =>
  (prompts[1] as Array<{ role: string; content: unknown[] }>)
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .find((p) => (p as { toolCallId?: string }).toolCallId === "tc1") as {
    output: { type: string; reason?: string };
  };

afterEach(() => clearToolGates());

describe("a Tool gate's deny", () => {
  it("stops the call in a Trigger run, hands the model the reason, and the run continues", async () => {
    gate("no-wipe", () => ({ verdict: "deny", reason: "Deletes data." }));
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run, outcome } = startRecordedRun();

    const { text } = await driveOnce({
      plan: planWith(model, executed),
      prompt: "go",
      run,
    });

    expect(executed).toEqual([]);
    expect(text).toBe("done");
    expect(outcome[0]?.status).toBe("succeeded");
    const result = toolResultSentBack(prompts);
    expect(result.output.type).toBe("execution-denied");
    expect(result.output.reason).toContain("no-wipe");
    expect(result.output.reason).toContain("Deletes data.");
  });

  it("stops the call in a Chat turn and shows the reason on the tool card", async () => {
    gate("no-wipe", () => ({ verdict: "deny", reason: "Deletes data." }));
    const { model } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    const drive = driveChat({
      plan: planWith(model, executed, { ...SCOPE, attended: true }),
      modelMessages: [{ role: "user", content: "go" }],
      run,
    });
    void (async () => {
      for await (const _ of drive.response);
    })();
    for await (const _ of drive.snapshots);
    const { messages } = await drive.done;

    expect(executed).toEqual([]);
    const part = messages
      ?.flatMap((m) => m.parts)
      .find((p) => (p.type as string) === "tool-wipe") as unknown as {
      state: string;
      approval?: { approved?: boolean; reason?: string };
    };
    expect(part.state).toBe("output-denied");
    expect(part.approval?.approved).toBe(false);
    expect(part.approval?.reason).toContain("Deletes data.");
  });

  it("stops the call in a Sub-Agent run", async () => {
    gate("no-wipe", () => ({ verdict: "deny" }));
    const { model } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    const drive = driveDelegate({
      agentId: "sub-1",
      plan: planWith(model, executed),
      prompt: "go",
      run,
    });
    for await (const _ of drive.snapshots);
    const result = await drive.done;

    expect(executed).toEqual([]);
    expect(result.status).toBe("succeeded");
  });

  it("is recorded on the Run timeline with its reason", async () => {
    gate("no-wipe", () => ({ verdict: "deny", reason: "Deletes data." }));
    const { model } = callThenAnswer();
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });

    await driveOnce({ plan: planWith(model, []), prompt: "go", run, events });

    const call = events.events.find((e) => e.type === "tool-call");
    expect(call?.status).toBe("cancelled");
    expect(call?.error?.message).toContain("Deletes data.");
  });

  it("repeated identically in an unattended run trips the no-progress detector", async () => {
    gate("no-wipe", () => ({ verdict: "deny", reason: "Deletes data." }));
    const { run, outcome } = startRecordedRun();

    await driveOnce({
      plan: planWith(callForever(), []),
      prompt: "go",
      run,
    });

    expect(outcome[0]?.status).toBe("failed");
    expect(outcome[0]?.error?.message).toMatch(/^no_progress:/);
  });
});

describe("an MCP tool", () => {
  // MCP tools enter a run as dynamic tools, under their namespaced name.
  it("is gated like any other", async () => {
    gate("no-wipe", () => ({ verdict: "deny" }));
    let executed = false;
    let index = 0;
    const model = new MockLanguageModelV3({
      doStream: () =>
        Promise.resolve({
          stream: simulateReadableStream({
            chunks:
              index++ === 0
                ? step(
                    [
                      {
                        type: "tool-call",
                        toolCallId: "tc1",
                        toolName: "files__wipe",
                        input: "{}",
                      },
                    ],
                    "tool-calls",
                  )
                : answerStep,
          }),
        }),
    });
    const { run } = startRecordedRun();

    await driveOnce({
      plan: {
        model,
        maxSteps: 4,
        gateScope: SCOPE,
        tools: {
          files__wipe: dynamicTool({
            inputSchema: z.object({}),
            execute: () => {
              executed = true;
              return Promise.resolve("wiped");
            },
          }),
        },
      },
      prompt: "go",
      run,
    });

    expect(executed).toBe(false);
  });
});

describe("failing closed", () => {
  it("does not run a call whose gate throws", async () => {
    gate("broken", () => {
      throw new Error("boom");
    });
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({
      plan: planWith(callThenAnswer().model, executed),
      prompt: "go",
      run,
    });

    expect(executed).toEqual([]);
  });

  it("does not run a call whose gate outruns its timeout", async () => {
    gate("slow", () => new Promise(() => {}), 20);
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({
      plan: planWith(callThenAnswer().model, executed),
      prompt: "go",
      run,
    });

    expect(executed).toEqual([]);
  });

  it("treats ask as deny, even in an attended Chat turn", async () => {
    gate("cautious", () => ({ verdict: "ask", reason: "Looks risky." }));
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    const drive = driveChat({
      plan: planWith(model, executed, { ...SCOPE, attended: true }),
      modelMessages: [{ role: "user", content: "go" }],
      run,
    });
    void (async () => {
      for await (const _ of drive.response);
    })();
    for await (const _ of drive.snapshots);
    await drive.done;

    expect(executed).toEqual([]);
    expect(toolResultSentBack(prompts).output.reason).toContain("Looks risky.");
  });

  it("does not run a call when the plan carries no gate scope", async () => {
    gate("open", () => ({ verdict: "allow" }));
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({
      plan: {
        ...planWith(callThenAnswer().model, executed),
        gateScope: undefined,
      },
      prompt: "go",
      run,
    });

    expect(executed).toEqual([]);
  });
});

describe("combining gates", () => {
  it("lets the most restrictive Verdict win", async () => {
    gate("open", () => ({ verdict: "allow" }));
    gate("strict", () => ({ verdict: "deny", reason: "Strict says no." }));
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({ plan: planWith(model, executed), prompt: "go", run });

    expect(executed).toEqual([]);
    expect(toolResultSentBack(prompts).output.reason).toContain(
      "Strict says no.",
    );
  });

  it("runs the call when every gate allows, and records nothing extra", async () => {
    gate("open", () => ({ verdict: "allow" }));
    gate("also-open", () => ({ verdict: "allow" }));
    const { model } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });

    await driveOnce({
      plan: planWith(model, executed),
      prompt: "go",
      run,
      events,
    });

    expect(executed).toEqual(["/data"]);
    const call = events.events.find((e) => e.type === "tool-call");
    expect(call?.status).toBe("completed");
    expect(call?.error).toBeNull();
  });
});

describe("what a gate is told", () => {
  it("receives the call, its Tool set and the run's scope", async () => {
    const seen = gate("watch", () => ({ verdict: "allow" }));
    const { run } = startRecordedRun();

    await driveOnce({
      plan: planWith(callThenAnswer().model, [], {
        ...SCOPE,
        readOnlyHints: new Map([["wipe", "writes"]]),
      }),
      prompt: "go",
      run,
    });

    expect(seen).toEqual([
      {
        toolName: "wipe",
        toolDescription: "Delete a directory.",
        args: { path: "/data" },
        toolSetId: "files",
        orgId: "org-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        attended: false,
        readOnlyHint: "writes",
      },
    ]);
  });
});

describe("with no gate enabled", () => {
  it("sends the Provider no approval hook and runs the call", async () => {
    const { model } = callThenAnswer();
    const executed: string[] = [];
    const plan = planWith(model, executed);
    const { run } = startRecordedRun();

    expect(
      "toolApproval" in
        buildModelInvocation(plan, {
          abortSignal: new AbortController().signal,
        }),
    ).toBe(false);
    await driveOnce({ plan, prompt: "go", run });
    expect(executed).toEqual(["/data"]);
  });
});
