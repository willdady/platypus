import { describe, it, expect } from "vitest";
import { DEFAULT_MAX_EXTRACTED_TEXT_CHARS } from "@platypus/schemas";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { startRun } from "../runs/run-lifecycle.ts";
import { runRegistry } from "../runs/run-registry.ts";
import { driveDelegate } from "../runs/drive.ts";
import type { RunStatus } from "../runs/types.ts";
import { createSandboxTools } from "./tools.ts";
import type { SandboxBackend, SandboxContext } from "./types.ts";

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};

const ctx: SandboxContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
};

const shellExecModel = (): MockLanguageModelV3 =>
  new MockLanguageModelV3({
    doStream: () => {
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "tool-input-start", id: "tc1", toolName: "shellExec" },
        { type: "tool-input-end", id: "tc1" },
        {
          type: "tool-call",
          toolCallId: "tc1",
          toolName: "shellExec",
          input: JSON.stringify({ command: "sleep 300" }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: USAGE,
        },
      ];
      return Promise.resolve({
        stream: simulateReadableStream({ chunks }),
      });
    },
  });

const neverSettlingBackend = (): {
  backend: SandboxBackend;
  entered: Promise<void>;
} => {
  let signalEntered = () => {};
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const backend = {
    shellExec: () => {
      signalEntered();
      return new Promise<never>(() => {});
    },
  } as unknown as SandboxBackend;
  return { backend, entered };
};

const startRecordedRun = (timeouts?: {
  perStepTimeoutMs?: number;
  perRunTimeoutMs?: number;
}) => {
  const outcome: Array<{ status: RunStatus }> = [];
  let terminated = () => {};
  const done = new Promise<void>((resolve) => {
    terminated = resolve;
  });
  const run = startRun({
    runId: `sandbox-cancel-${Math.random().toString(36).slice(2)}`,
    timeouts,
    onTerminate: ({ status }) => {
      outcome.push({ status });
      terminated();
    },
  });
  return { run, outcome, terminated: done };
};

const driveAgainst = (
  backend: SandboxBackend,
  run: ReturnType<typeof startRun>,
) => {
  const drive = driveDelegate({
    plan: {
      model: shellExecModel(),
      tools: createSandboxTools(backend, ctx, {}, () =>
        Promise.resolve({
          passthroughFileTypes: [],
          maxExtractedTextChars: DEFAULT_MAX_EXTRACTED_TEXT_CHARS,
        }),
      ),
      maxSteps: 3,
    },
    run,
    prompt: "run something long",
    agentId: "sub-1",
  });
  const drained = (async () => {
    for await (const _ of drive.snapshots) void _;
  })();
  return { done: drive.done, drained };
};

describe("a sandbox tool in flight when the run aborts", () => {
  it("finishes the run as cancelled when the turn is stopped", async () => {
    const { run, outcome } = startRecordedRun();
    const { backend, entered } = neverSettlingBackend();

    const drive = driveAgainst(backend, run);

    await entered;
    runRegistry.cancel(run.handle.runId);

    await drive.drained;
    const result = await drive.done;

    expect(result.status).toBe("cancelled");
    expect(outcome).toEqual([{ status: "cancelled" }]);
  });

  it.each([
    ["run", { perRunTimeoutMs: 50 }],
    ["step", { perStepTimeoutMs: 50 }],
  ])(
    "still reaches a terminal status on a %s timeout",
    async (_name, timeouts) => {
      const { run, outcome, terminated } = startRecordedRun(timeouts);
      const { backend } = neverSettlingBackend();

      const drive = driveAgainst(backend, run);

      await terminated;
      await drive.drained;
      await drive.done;

      expect(outcome).toEqual([{ status: "failed" }]);
    },
  );
});
