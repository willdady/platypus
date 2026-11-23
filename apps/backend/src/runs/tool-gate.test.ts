import { afterEach, describe, expect, it, vi } from "vitest";
import {
  convertToModelMessages,
  dynamicTool,
  simulateReadableStream,
} from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import type {
  ToolGateCall,
  ToolGateVerdict,
  ToolResultVerdict,
} from "@platypuschat/plugin-sdk";
import { startRun } from "./run-lifecycle.ts";
import { driveChat, driveDelegate, driveOnce } from "./drive.ts";
import type { RunPlan } from "./run-plan.ts";
import { RunEventRecorder } from "./run-events.ts";
import type { RunStatus } from "./types.ts";
import type { PlatypusUIMessage } from "../types.ts";
import {
  registerToolGate,
  wrapToolsWithToolResultGate,
  type ToolGateRegistration,
  type ToolGateScope,
} from "../tool-gates/index.ts";
import {
  createDelegateTool,
  type SubAgentDelegate,
} from "../tools/sub-agent.ts";
import { DELEGATE_TOOL_NAME } from "../tools/turn-tool-names.ts";

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

const callToolThenAnswer = (toolName: string, input: object) => {
  const prompts: unknown[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doStream: (options) => {
      prompts.push(options.prompt);
      const parts =
        index === 0
          ? step(
              [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName,
                  input: JSON.stringify(input),
                },
              ],
              "tool-calls",
            )
          : answerStep;
      index += 1;
      return Promise.resolve({
        stream: simulateReadableStream({ chunks: parts }),
      });
    },
  });
  return { model, prompts };
};

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

// why: no unregister exists, so each case silences the gates it registered
const registered: ToolGateRegistration[] = [];
let seq = 0;

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

const gate = (
  id: string,
  answer: (call: ToolGateCall) => ToolGateVerdict | Promise<ToolGateVerdict>,
  {
    timeoutMs = 1_000,
    evaluateResult,
  }: {
    timeoutMs?: number;
    evaluateResult?: (
      call: ToolGateCall,
      result: unknown,
    ) => ToolResultVerdict | Promise<ToolResultVerdict>;
  } = {},
) => {
  const seen: ToolGateCall[] = [];
  const results: Array<{ call: ToolGateCall; result: unknown }> = [];
  const registration: ToolGateRegistration = {
    // why: each case names its own gate, because a registration never expires
    id: `${id}-${(seq += 1)}`,
    name: id,
    timeoutMs,
    evaluate: (call) => {
      seen.push(call);
      return answer(call);
    },
    ...(evaluateResult
      ? {
          evaluateResult: (call, result) => {
            results.push({ call, result });
            return evaluateResult(call, result);
          },
        }
      : {}),
  };
  registered.push(registration);
  registerToolGate(registration);
  return { seen, results };
};

const toolResultSentBack = (prompts: unknown[]) =>
  (prompts[1] as Array<{ role: string; content: unknown[] }>)
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .find((p) => (p as { toolCallId?: string }).toolCallId === "tc1") as {
    output: { type: string; reason?: string; value?: unknown };
  };

const resultGate = (
  id: string,
  answer: (
    call: ToolGateCall,
    result: unknown,
  ) => ToolResultVerdict | Promise<ToolResultVerdict>,
  timeoutMs = 1_000,
) =>
  gate(id, () => ({ verdict: "allow" }), {
    timeoutMs,
    evaluateResult: answer,
  }).results;

afterEach(() => {
  for (const registration of registered.splice(0)) {
    registration.evaluate = () => ({ verdict: "allow" });
    delete registration.evaluateResult;
  }
});

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
    gate("slow", () => new Promise(() => {}), { timeoutMs: 20 });
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({
      plan: planWith(callThenAnswer().model, executed),
      prompt: "go",
      run,
    });

    expect(executed).toEqual([]);
  });

  it("treats ask as deny in an unattended run", async () => {
    gate("cautious", () => ({ verdict: "ask", reason: "Looks risky." }));
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({ plan: planWith(model, executed), prompt: "go", run });

    expect(executed).toEqual([]);
    const reason = toolResultSentBack(prompts).output.reason;
    expect(reason).toContain("Looks risky.");
    expect(reason).toContain("no one can approve it here");
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

const drain = async (drive: ReturnType<typeof driveChat>) => {
  void (async () => {
    for await (const _ of drive.response);
  })();
  for await (const _ of drive.snapshots);
  return drive.done;
};

type ToolPart = {
  type: string;
  toolCallId: string;
  state: string;
  errorText?: string;
  approval?: {
    id: string;
    approved?: boolean;
    reason?: string;
    requestReason?: string;
  };
};

const toolParts = (messages: PlatypusUIMessage[] | undefined) =>
  (messages ?? [])
    .flatMap((m) => m.parts)
    .filter((p) => (p.type as string) === "tool-wipe") as unknown as ToolPart[];

const threeCallsThenAnswer = () => {
  const prompts: unknown[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doStream: (options) => {
      prompts.push(options.prompt);
      const parts =
        index === 0
          ? step(
              [
                {
                  type: "tool-call",
                  toolCallId: "tc1",
                  toolName: "wipe",
                  input: JSON.stringify({ path: "/a" }),
                },
                {
                  type: "tool-call",
                  toolCallId: "tc2",
                  toolName: "wipe",
                  input: JSON.stringify({ path: "/b" }),
                },
                {
                  type: "tool-call",
                  toolCallId: "tc3",
                  toolName: "wipe",
                  input: JSON.stringify({ path: "/c" }),
                },
              ],
              "tool-calls",
            )
          : answerStep;
      index += 1;
      return Promise.resolve({
        stream: simulateReadableStream({ chunks: parts }),
      });
    },
  });
  return { model, prompts };
};

describe("a Tool gate's ask in an attended Chat turn", () => {
  const ATTENDED = { ...SCOPE, attended: true };

  it("stops the turn after the step and asks the User, with the gate's reason", async () => {
    const verdicts: Record<string, ToolGateVerdict> = {
      "/a": { verdict: "ask", reason: "Looks risky." },
      "/b": { verdict: "allow" },
      "/c": { verdict: "deny" },
    };
    gate("cautious", (call) => verdicts[(call.args as { path: string }).path]);
    const { model, prompts } = threeCallsThenAnswer();
    const executed: string[] = [];
    const { run, outcome } = startRecordedRun();

    const { messages } = await drain(
      driveChat({
        plan: planWith(model, executed, ATTENDED),
        modelMessages: [{ role: "user", content: "go" }],
        run,
      }),
    );

    expect(executed).toEqual(["/b"]);
    expect(prompts).toHaveLength(1);
    expect(outcome[0]?.status).toBe("succeeded");
    const [asked, allowed, denied] = toolParts(messages);
    expect(asked.state).toBe("approval-requested");
    expect(asked.approval?.requestReason).toBe("Looks risky.");
    expect(allowed.state).toBe("output-available");
    expect(denied.state).toBe("output-denied");
  });

  const askThenResume = async (approved: boolean, reason?: string) => {
    let gateCalls = 0;
    gate("cautious", () => {
      gateCalls += 1;
      if (gateCalls > 1) throw new Error("re-vetted an approved call");
      return { verdict: "ask", reason: "Looks risky." };
    });
    const first = callThenAnswer();
    const executed: string[] = [];
    const stopped = await drain(
      driveChat({
        plan: planWith(first.model, executed, ATTENDED),
        modelMessages: [{ role: "user", content: "go" }],
        run: startRecordedRun().run,
      }),
    );
    const reply = stopped.messages?.at(-1) as PlatypusUIMessage;
    const answered = {
      ...reply,
      metadata: { ...reply.metadata, stoppedAtStepLimit: true as const },
      parts: reply.parts.map((p) => {
        const part = p as unknown as ToolPart;
        return part.state === "approval-requested"
          ? ({
              ...part,
              state: "approval-responded",
              approval: { ...part.approval, approved, reason },
            } as unknown as typeof p)
          : p;
      }),
    };
    const user: PlatypusUIMessage = {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "go" }],
    };
    const prompts: unknown[] = [];
    const second = new MockLanguageModelV3({
      doStream: (options) => {
        prompts.push(options.prompt);
        return Promise.resolve({
          stream: simulateReadableStream({ chunks: answerStep }),
        });
      },
    });
    const resumed = await drain(
      driveChat({
        plan: planWith(second, executed, ATTENDED),
        modelMessages: await convertToModelMessages([user, answered]),
        originalMessages: [user, answered],
        run: startRecordedRun().run,
      }),
    );
    return { reply, resumed, executed, gateCalls, prompts };
  };

  it("runs an approved call without asking any gate again, and continues the same reply", async () => {
    const { reply, resumed, executed, gateCalls } = await askThenResume(true);

    expect(executed).toEqual(["/data"]);
    expect(gateCalls).toBe(1);
    expect(resumed.messages).toHaveLength(2);
    const continued = resumed.messages?.at(-1);
    expect(continued?.id).toBe(reply.id);
    expect(toolParts(resumed.messages)[0]?.state).toBe("output-available");
    expect(continued?.metadata?.stoppedAtStepLimit).toBeUndefined();
  });

  it("hands the model a denied call with the User's reason", async () => {
    const { resumed, executed, prompts } = await askThenResume(
      false,
      "The User denied this call.",
    );

    expect(executed).toEqual([]);
    expect(toolParts(resumed.messages)[0]?.state).toBe("output-denied");
    const denial = (prompts[0] as Array<{ role: string; content: unknown[] }>)
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .find(
        (p) =>
          (p as { type: string }).type === "tool-result" &&
          (p as { toolCallId?: string }).toolCallId === "tc1",
      ) as { output: { type: string; reason?: string } };
    expect(denial.output).toEqual({
      type: "execution-denied",
      reason: "The User denied this call.",
    });
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

  it("gives the first denying gate's reason when several deny", async () => {
    gate("first", () => ({ verdict: "deny", reason: "First says no." }));
    gate("second", () => ({ verdict: "deny", reason: "Second says no." }));
    const { model, prompts } = callThenAnswer();
    const { run } = startRecordedRun();

    await driveOnce({ plan: planWith(model, []), prompt: "go", run });

    const { reason } = toolResultSentBack(prompts).output;
    expect(reason).toContain("First says no.");
    expect(reason).not.toContain("Second says no.");
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
    const { seen } = gate("watch", () => ({ verdict: "allow" }));
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

describe("a Tool gate's result stage", () => {
  it("withholds a denied result and tells the model the tool ran", async () => {
    const seen = resultGate("screener", () => ({
      verdict: "deny",
      reason: "Contains a prompt injection.",
    }));
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run, outcome } = startRecordedRun();

    await driveOnce({ plan: planWith(model, executed), prompt: "go", run });

    expect(executed).toEqual(["/data"]);
    expect(outcome[0]?.status).toBe("succeeded");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.call).toEqual({
      toolName: "wipe",
      toolDescription: "Delete a directory.",
      args: { path: "/data" },
      toolSetId: "files",
      orgId: "org-1",
      workspaceId: "ws-1",
      agentId: "agent-1",
      attended: false,
      readOnlyHint: "undeclared",
    });
    expect(seen[0]?.result).toBe("wiped");

    expect(JSON.stringify(prompts)).not.toContain("wiped");
    const result = toolResultSentBack(prompts);
    expect(result.output.type).toBe("error-text");
    expect(result.output.value).toContain("screener");
    expect(result.output.value).toContain("Contains a prompt injection.");
    expect(result.output.value).toMatch(/ran/);
  });

  it("does not evaluate results when no gate declares a result stage", async () => {
    gate("open", () => ({ verdict: "allow" }));
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({ plan: planWith(model, executed), prompt: "go", run });

    expect(executed).toEqual(["/data"]);
    expect(toolResultSentBack(prompts).output).toEqual({
      type: "text",
      value: "wiped",
    });
  });

  it("leaves the tool map itself untouched when no gate declares a result stage", () => {
    gate("open", () => ({ verdict: "allow" }));
    const tools = {
      wipe: {
        description: "Delete a directory.",
        inputSchema: z.object({ path: z.string() }),
        execute: () => "wiped",
      },
    };

    expect(
      wrapToolsWithToolResultGate(tools, SCOPE, new AbortController().signal),
    ).toBe(tools);
  });

  it("withholds a result when the gate throws", async () => {
    resultGate("broken", () => {
      throw new Error("boom");
    });
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({ plan: planWith(model, executed), prompt: "go", run });

    expect(executed).toEqual(["/data"]);
    expect(JSON.stringify(prompts)).not.toContain("wiped");
    const value = toolResultSentBack(prompts).output.value;
    expect(value).toContain("broken");
    expect(value).toContain("boom");
  });

  it("withholds a result when the gate outruns its timeout", async () => {
    resultGate("slow", () => new Promise(() => {}), 20);
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({ plan: planWith(model, executed), prompt: "go", run });

    expect(executed).toEqual(["/data"]);
    expect(JSON.stringify(prompts)).not.toContain("wiped");
    expect(toolResultSentBack(prompts).output.value).toContain("slow");
  });

  it("lets the first denying gate's reason win when several deny", async () => {
    resultGate("open", () => ({ verdict: "allow" }));
    resultGate("first", () => ({
      verdict: "deny",
      reason: "First says no.",
    }));
    resultGate("second", () => ({
      verdict: "deny",
      reason: "Second says no.",
    }));
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    await driveOnce({ plan: planWith(model, executed), prompt: "go", run });

    expect(executed).toEqual(["/data"]);
    const value = toolResultSentBack(prompts).output.value as string;
    expect(value).toContain("First says no.");
    expect(value).not.toContain("Second says no.");
  });

  it("passes the result through unchanged when every gate allows", async () => {
    const first = resultGate("open", () => ({ verdict: "allow" }));
    const second = resultGate("also-open", () => ({ verdict: "allow" }));
    const { model, prompts } = callThenAnswer();
    const executed: string[] = [];
    const { run, outcome } = startRecordedRun();

    await driveOnce({ plan: planWith(model, executed), prompt: "go", run });

    expect(executed).toEqual(["/data"]);
    expect(outcome[0]?.status).toBe("succeeded");
    expect(first[0]?.result).toBe("wiped");
    expect(second[0]?.result).toBe("wiped");
    expect(toolResultSentBack(prompts).output).toEqual({
      type: "text",
      value: "wiped",
    });
  });

  it("withholds a denied result from the stored Chat message and the stream", async () => {
    resultGate("screener", () => ({
      verdict: "deny",
      reason: "Contains a prompt injection.",
    }));
    const { model } = callThenAnswer();
    const executed: string[] = [];
    const { run } = startRecordedRun();

    const drive = driveChat({
      plan: planWith(model, executed, { ...SCOPE, attended: true }),
      modelMessages: [{ role: "user", content: "go" }],
      run,
    });
    let streamed = "";
    void (async () => {
      for await (const chunk of drive.response)
        streamed += JSON.stringify(chunk);
    })();
    for await (const snapshot of drive.snapshots)
      streamed += JSON.stringify(snapshot);
    const { messages } = await drive.done;

    expect(executed).toEqual(["/data"]);
    expect(JSON.stringify(messages)).not.toContain("wiped");
    expect(streamed).not.toContain("wiped");
    const part = toolParts(messages)[0];
    expect(part.state).toBe("output-error");
    expect(part.errorText).toContain("Contains a prompt injection.");
  });

  it("withholds a denied result in a Sub-Agent run", async () => {
    resultGate("screener", () => ({
      verdict: "deny",
      reason: "Contains a prompt injection.",
    }));
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

    expect(executed).toEqual(["/data"]);
    expect(result.status).toBe("succeeded");
    expect(JSON.stringify(result)).not.toContain("wiped");
  });

  it("withholds a denied delegation result in the parent", async () => {
    resultGate("screener", (call) =>
      call.toolName === DELEGATE_TOOL_NAME
        ? { verdict: "deny", reason: "Inside the sub-agent answer." }
        : { verdict: "allow" },
    );
    let ran = false;
    const delegate: SubAgentDelegate = {
      id: "sub-1",
      name: "Researcher",
      description: "Researches.",
      run: async function* () {
        ran = true;
        await Promise.resolve();
        yield {
          entries: [
            { type: "tool-call", toolName: "search", status: "completed" },
          ],
        };
        yield { entries: [], text: "SECRET-FINDING" };
      },
    };
    const { model, prompts } = callToolThenAnswer(DELEGATE_TOOL_NAME, {
      subAgent: "Researcher",
      task: "Find the answer.",
    });
    const drive = driveChat({
      plan: {
        model,
        maxSteps: 4,
        gateScope: { ...SCOPE, attended: true },
        tools: { [DELEGATE_TOOL_NAME]: createDelegateTool([delegate]) },
      },
      modelMessages: [{ role: "user", content: "go" }],
      run: startRecordedRun().run,
    });
    let streamed = "";
    void (async () => {
      for await (const chunk of drive.response)
        streamed += JSON.stringify(chunk);
    })();
    for await (const snapshot of drive.snapshots)
      streamed += JSON.stringify(snapshot);
    const { messages } = await drive.done;

    expect(ran).toBe(true);
    expect(JSON.stringify(prompts)).not.toContain("SECRET-FINDING");
    expect(streamed).not.toContain("SECRET-FINDING");
    expect(JSON.stringify(messages)).not.toContain("SECRET-FINDING");
    const value = toolResultSentBack(prompts).output.value as string;
    expect(value).toContain("screener");
    expect(value).toContain("Inside the sub-agent answer.");
  });

  it("vets a tool's error as its result, withholding fetched content it carries", async () => {
    const seen = resultGate("screener", (_call, result) =>
      String(result).includes("INJECTED")
        ? { verdict: "deny", reason: "Inside the error." }
        : { verdict: "allow" },
    );
    const { model, prompts } = callThenAnswer();
    const plan = planWith(model, []);
    plan.tools.wipe = {
      ...plan.tools.wipe,
      execute: () => Promise.reject(new Error("Fetched page said INJECTED")),
    };

    await driveOnce({ plan, prompt: "go", run: startRecordedRun().run });

    expect(String(seen[0]?.result)).toContain("INJECTED");
    expect(JSON.stringify(prompts)).not.toContain("INJECTED");
    expect(toolResultSentBack(prompts).output.value).toContain(
      "Inside the error.",
    );
  });

  it("passes an allowed tool error through unchanged", async () => {
    resultGate("open", () => ({ verdict: "allow" }));
    const { model, prompts } = callThenAnswer();
    const plan = planWith(model, []);
    plan.tools.wipe = {
      ...plan.tools.wipe,
      execute: () => {
        throw new Error("Disk is read-only.");
      },
    };

    await driveOnce({ plan, prompt: "go", run: startRecordedRun().run });

    expect(toolResultSentBack(prompts).output).toMatchObject({
      type: "error-text",
      value: expect.stringContaining("Disk is read-only.") as unknown,
    });
  });

  it("withholds a failed delegation's partial output but still streams its failure", async () => {
    resultGate("screener", (_call, result) =>
      String(result).includes("PARTIAL-SECRET")
        ? { verdict: "deny", reason: "Inside the partial output." }
        : { verdict: "allow" },
    );
    const delegate: SubAgentDelegate = {
      id: "sub-1",
      name: "Researcher",
      description: "Researches.",
      run: async function* () {
        await Promise.resolve();
        yield { entries: [{ type: "failed", status: "error", error: "x" }] };
        throw new Error("Partial output before the failure:\nPARTIAL-SECRET");
      },
    };
    const { model, prompts } = callToolThenAnswer(DELEGATE_TOOL_NAME, {
      subAgent: "Researcher",
      task: "Find the answer.",
    });
    const drive = driveChat({
      plan: {
        model,
        maxSteps: 4,
        gateScope: { ...SCOPE, attended: true },
        tools: { [DELEGATE_TOOL_NAME]: createDelegateTool([delegate]) },
      },
      modelMessages: [{ role: "user", content: "go" }],
      run: startRecordedRun().run,
    });
    let streamed = "";
    void (async () => {
      for await (const chunk of drive.response)
        streamed += JSON.stringify(chunk);
    })();
    for await (const snapshot of drive.snapshots)
      streamed += JSON.stringify(snapshot);
    const { messages } = await drive.done;

    expect(JSON.stringify(prompts)).not.toContain("PARTIAL-SECRET");
    expect(streamed).not.toContain("PARTIAL-SECRET");
    expect(JSON.stringify(messages)).not.toContain("PARTIAL-SECRET");
    expect(streamed).toContain('"type":"failed"');
    expect(toolResultSentBack(prompts).output.value).toContain(
      "Inside the partial output.",
    );
  });

  it("closes the Run timeline as a tool error without recording the result", async () => {
    resultGate("screener", () => ({
      verdict: "deny",
      reason: "Contains a prompt injection.",
    }));
    const { model } = callThenAnswer();
    const { run } = startRecordedRun();
    const events = new RunEventRecorder({ runId: run.handle.runId });

    await driveOnce({
      plan: planWith(model, []),
      prompt: "go",
      run,
      events,
    });

    expect(JSON.stringify(events.events)).not.toContain("wiped");
    const call = events.events.find((e) => e.type === "tool-call");
    expect(call?.status).toBe("error");
    expect(call?.error?.message).toContain("Contains a prompt injection.");
  });
});

describe("with no gate enabled", () => {
  it("sends the Provider no approval hook and runs the call", async () => {
    // why: needs a graph whose Tool gate registry was never touched
    vi.resetModules();
    const [
      { buildModelInvocation },
      { createOverflowRecovery },
      { driveOnce },
      { startRun },
    ] = await Promise.all([
      import("./run-plan.ts"),
      import("./context-overflow-recovery.ts"),
      import("./drive.ts"),
      import("./run-lifecycle.ts"),
    ]);

    const { model } = callThenAnswer();
    const executed: string[] = [];
    const plan = planWith(model, executed);
    const run = startRun({
      runId: "no-gate",
      onTerminate: () => {},
    });

    expect(
      "toolApproval" in
        buildModelInvocation(plan, {
          abortSignal: new AbortController().signal,
          overflowRecovery: createOverflowRecovery(),
        }),
    ).toBe(false);
    await driveOnce({ plan, prompt: "go", run });
    expect(executed).toEqual(["/data"]);
  });
});
