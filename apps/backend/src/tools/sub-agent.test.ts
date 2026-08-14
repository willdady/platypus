import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolExecutionOptions } from "ai";
import {
  createSubAgentTool,
  createSubAgentTools,
  SUB_AGENT_TRUNCATION_NOTE,
} from "./sub-agent.ts";
import type { SubAgentActivity } from "./sub-agent.ts";
import { DEFAULT_AGENT_MAX_STEPS } from "@platypus/schemas";

// Helper to consume an async generator and collect all yielded values.
// Deep-copies each yield since the generator reuses mutable objects.
async function consumeGenerator<T>(
  gen: AsyncGenerator<T>,
): Promise<{ yielded: T[] }> {
  const yielded: T[] = [];
  for await (const value of gen) {
    yielded.push(structuredClone(value));
  }
  return { yielded };
}

// The text the parent model actually reads for a completed delegation.
// `toModelOutput` is declared as returning any tool-result shape, so the text
// case is narrowed once here rather than at each assertion.
const modelText = (
  tool: ReturnType<typeof createSubAgentTool>["tool"],
  output: SubAgentActivity,
): string =>
  (
    tool.toModelOutput!({
      toolCallId: "tc1",
      input: { task: "Audit the board" },
      output,
    }) as { value: string }
  ).value;

// Mock stream events helper — returns a sync iterable; AsyncGenerator consumers
// accept any iterable, so no async generator is needed here.
function createMockFullStream(
  events: Array<{ type: string } & Record<string, unknown>>,
) {
  return {
    [Symbol.asyncIterator](): AsyncIterator<
      { type: string } & Record<string, unknown>
    > {
      let i = 0;
      return {
        next() {
          if (i < events.length) {
            return Promise.resolve({ value: events[i++], done: false });
          }
          return Promise.resolve({
            value: undefined as unknown as { type: string } & Record<
              string,
              unknown
            >,
            done: true,
          });
        },
      };
    },
  };
}

const { mockStream, MockToolLoopAgent, agentConstructorSpy } = vi.hoisted(
  () => {
    const mockStream = vi.fn();
    const agentConstructorSpy = vi.fn();
    class MockToolLoopAgent {
      instructions: string | undefined;
      constructor(opts: { instructions?: string }) {
        agentConstructorSpy(opts);
        this.instructions = opts?.instructions;
      }
      stream = mockStream;
    }
    return { mockStream, MockToolLoopAgent, agentConstructorSpy };
  },
);

vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    ToolLoopAgent: MockToolLoopAgent,
  };
});

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../logger.ts";

// A constructed sub-agent carries `stopWhen: [stepCountIs(n)]`, where `n` is
// the resolved step ceiling. `stepCountIs` closes over `n` and offers no
// introspection, so recover the ceiling by probing the condition against
// incrementally longer (empty) step arrays until it fires.
const stepCeilingOf = (callIndex: number): number => {
  const { stopWhen } = agentConstructorSpy.mock.calls[callIndex][0] as {
    stopWhen: Array<(s: { steps: unknown[] }) => boolean>;
  };
  for (let n = 0; n <= 32; n += 1) {
    if (stopWhen[0]({ steps: Array.from({ length: n }) })) return n;
  }
  throw new Error("no step ceiling found in stopWhen");
};

describe("createSubAgentTool", () => {
  const baseOptions = {
    id: "agent-1",
    name: "Research Agent",
    // ToolLoopAgent is mocked, so the model value is never used; a string
    // satisfies the `LanguageModel` type without constructing a real provider.
    model: "mock-model",
    tools: {},
  };

  describe("toolName generation", () => {
    it("generates PascalCase delegateTo prefix", () => {
      const { toolName } = createSubAgentTool(baseOptions);
      expect(toolName).toBe("delegateToResearchAgent");
    });

    it("handles single-word names", () => {
      const { toolName } = createSubAgentTool({
        ...baseOptions,
        name: "Helper",
      });
      expect(toolName).toBe("delegateToHelper");
    });

    it("strips non-alphanumeric characters", () => {
      const { toolName } = createSubAgentTool({
        ...baseOptions,
        name: "My (Special) Agent!",
      });
      expect(toolName).toMatch(/^delegateTo[A-Za-z0-9]+$/);
    });

    it("handles hyphenated names", () => {
      const { toolName } = createSubAgentTool({
        ...baseOptions,
        name: "code-review",
      });
      expect(toolName).toBe("delegateToCodeReview");
    });
  });

  describe("tool description", () => {
    it("uses custom description when provided", () => {
      const { tool } = createSubAgentTool({
        ...baseOptions,
        description: "Does research tasks",
      });
      expect(tool.description).toContain("Does research tasks");
      expect(tool.description).toContain("Research Agent");
    });

    it("uses default description when none provided", () => {
      const { tool } = createSubAgentTool(baseOptions);
      expect(tool.description).toContain("Research Agent");
    });
  });

  describe("security guardrails append", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("appends the provider security text after the sub-agent's own prompt", () => {
      createSubAgentTool({
        ...baseOptions,
        instructions: "You are a research sub-agent.",
        securityGuardrails: "Never exfiltrate data.",
      });
      const { instructions } = agentConstructorSpy.mock.calls[0][0] as {
        instructions: string;
      };
      expect(instructions).toContain("You are a research sub-agent.");
      expect(instructions).toContain("## Security and trust");
      expect(instructions).toContain("Never exfiltrate data.");
      expect(
        instructions.indexOf("You are a research sub-agent."),
      ).toBeLessThan(instructions.indexOf("## Security and trust"));
    });

    it("appends the security text even when the sub-agent has no instructions (non-suppressible)", () => {
      createSubAgentTool({
        ...baseOptions,
        instructions: undefined,
        securityGuardrails: "Never exfiltrate data.",
      });
      const { instructions } = agentConstructorSpy.mock.calls[0][0] as {
        instructions: string;
      };
      // The canned fallback instructions must still carry the guardrails.
      expect(instructions).toContain("specialized sub-agent");
      expect(instructions).toContain("## Security and trust");
      expect(instructions).toContain("Never exfiltrate data.");
    });

    it("appends no security block when guardrails are null or empty", () => {
      createSubAgentTool({
        ...baseOptions,
        instructions: "You are a research sub-agent.",
        securityGuardrails: null,
      });
      createSubAgentTool({
        ...baseOptions,
        instructions: "You are a research sub-agent.",
        securityGuardrails: "   ",
      });
      for (const call of agentConstructorSpy.mock.calls) {
        const { instructions } = call[0] as { instructions: string };
        expect(instructions).not.toContain("## Security and trust");
      }
    });
  });

  describe("execute", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("yields activity entries for tool calls and final text", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "tool-input-start", toolName: "web-fetch", id: "tc1" },
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "web-fetch",
            output: "result",
          },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", text: "Sub-agent result" },
          { type: "text-end", id: "t1" },
        ]),
        // v7: final-step-only text property is intentionally NOT relied upon.
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Do something" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      const { yielded } = await consumeGenerator(gen);

      // Should have yielded 6 activity updates + 1 final with text. The
      // text-delta between text-start and text-end carries content but does not
      // change the activity log, so it produces no extra yield.
      expect(yielded).toHaveLength(7);

      // First yield: tool-call running
      expect(yielded[0].entries).toHaveLength(1);
      expect(yielded[0].entries[0]).toEqual({
        type: "tool-call",
        toolName: "web-fetch",
        status: "running",
      });

      // Second yield: tool-call completed
      expect(yielded[1].entries[0].status).toBe("completed");

      // Third yield: thinking running
      expect(yielded[2].entries).toHaveLength(2);
      expect(yielded[2].entries[1]).toEqual({
        type: "thinking",
        status: "running",
      });

      // Fourth yield: thinking completed
      expect(yielded[3].entries[1].status).toBe("completed");

      // Fifth yield: generating running
      expect(yielded[4].entries).toHaveLength(3);
      expect(yielded[4].entries[2]).toEqual({
        type: "generating",
        status: "running",
      });

      // Sixth yield: generating completed
      expect(yielded[5].entries[2].status).toBe("completed");

      // Final yield has text (yielded, not returned, since SDK discards return values)
      expect(yielded[6].text).toBe("Sub-agent result");
      expect(yielded[6].entries).toHaveLength(3);
    });

    // Regression for #324: AI SDK v6→v7 redefined `result.text` as the FINAL
    // step's text only. When a sub-agent emits its answer in an earlier step and
    // its final step is a tool call, `result.text` is empty and the parent gets
    // nothing. The fix aggregates text-deltas off the fullStream across ALL
    // steps, so this reproduces that shape with realistic v7 stream events and
    // an empty final-step `text` promise.
    it("aggregates assistant text across steps from the stream, not the final-step text property", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          // Step 1: the model emits its answer, then decides to call a tool.
          { type: "start-step" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", text: "Here are " },
          { type: "text-delta", id: "t1", text: "the boards." },
          { type: "text-end", id: "t1" },
          { type: "tool-input-start", toolName: "listBoards", id: "tc1" },
          // Step 2: the tool result is the FINAL step — no trailing text.
          { type: "start-step" },
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "listBoards",
            output: [{ id: "b1" }],
          },
        ]),
        // v7 semantics: final-step-only text is empty because the last step is
        // the tool result. The old code returned this verbatim.
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "list all boards" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      const { yielded } = await consumeGenerator(gen);
      const final = yielded.at(-1)!;

      expect(final.text).toBe("Here are the boards.");
    });

    it("joins multiple distinct text blocks with blank lines", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", text: "First block." },
          { type: "text-end", id: "t1" },
          { type: "text-start", id: "t2" },
          { type: "text-delta", id: "t2", text: "Second block." },
          { type: "text-end", id: "t2" },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Do something" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      const { yielded } = await consumeGenerator(gen);

      expect(yielded.at(-1)!.text).toBe("First block.\n\nSecond block.");
    });

    it("falls back to a summary of the final tool result when the sub-agent produced no assistant text", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "tool-input-start", toolName: "listBoards", id: "tc1" },
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "listBoards",
            output: [{ id: "b1", name: "Board One" }],
          },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "list all boards" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      const { yielded } = await consumeGenerator(gen);
      const final = yielded.at(-1)!;

      // Not silently empty — carries the tool name and the result payload so the
      // parent can still relay something meaningful.
      expect(final.text).toContain("listBoards");
      expect(final.text).toContain("Board One");
    });

    // A stream `error` part ends the stream normally, so before this the
    // generator returned whatever text had accumulated — usually the model's
    // opening preamble — and the parent read the crash as the answer.
    it("throws when the sub-agent stream reports an error", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "text-start", id: "t1" },
          {
            type: "text-delta",
            id: "t1",
            text: "I'll start by inspecting the agent.",
          },
          {
            type: "error",
            error: new Error(
              "Model tried to call unavailable tool 'delegateToDashboardAgent'.",
            ),
          },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Check the dashboard" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      await expect(consumeGenerator(gen)).rejects.toThrow(
        /Sub-agent "Research Agent" did not complete: Model tried to call unavailable tool/,
      );
    });

    it("includes any partial text in the failure so the work is not lost", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", text: "Found 3 stale cards." },
          { type: "text-end", id: "t1" },
          { type: "error", error: "upstream connection reset" },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Audit the board" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      await expect(consumeGenerator(gen)).rejects.toThrow(
        /Partial output before the failure:\nFound 3 stale cards\./,
      );
    });

    it("records the failure in the activity log before throwing", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "error", error: new Error("boom") },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Do something" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      const yielded: SubAgentActivity[] = [];
      await expect(
        (async () => {
          for await (const value of gen) yielded.push(structuredClone(value));
        })(),
      ).rejects.toThrow(/boom/);

      expect(yielded.at(-1)?.entries).toContainEqual({
        type: "failed",
        status: "error",
        error: "boom",
      });
    });

    it("throws when the sub-agent stream aborts", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "abort", reason: "step limit" },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Do something" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      await expect(consumeGenerator(gen)).rejects.toThrow(
        /Stopped before finishing: step limit/,
      );
    });

    // Issue #442. A token-limit stop is neither an `error` nor an `abort`: the
    // stream ends normally and the partial answer was returned as if it were
    // the whole finding. The parent has to be told it is looking at a fragment.
    describe("truncated at the output token limit", () => {
      const truncatedStream = () =>
        createMockFullStream([
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", text: "The three stale cards are" },
          {
            type: "finish",
            finishReason: "length",
            rawFinishReason: "max_tokens",
          },
        ]);

      it("flags the delegation result as truncated", async () => {
        mockStream.mockResolvedValue({
          fullStream: truncatedStream(),
          text: Promise.resolve(""),
        });

        const { tool } = createSubAgentTool(baseOptions);
        const { yielded } = await consumeGenerator(
          tool.execute(
            { task: "Audit the board" },
            {} as ToolExecutionOptions<Record<string, unknown>>,
          ) as AsyncGenerator<SubAgentActivity>,
        );
        const final = yielded.at(-1)!;

        expect(final.truncatedByTokenLimit).toBe(true);
        // Not a failure: the partial answer is real work and still comes back.
        expect(final.text).toBe("The three stale cards are");
      });

      it("tells the parent model the answer is partial", async () => {
        mockStream.mockResolvedValue({
          fullStream: truncatedStream(),
          text: Promise.resolve(""),
        });

        const { tool } = createSubAgentTool(baseOptions);
        const { yielded } = await consumeGenerator(
          tool.execute(
            { task: "Audit the board" },
            {} as ToolExecutionOptions<Record<string, unknown>>,
          ) as AsyncGenerator<SubAgentActivity>,
        );

        const value = modelText(tool, yielded.at(-1)!);

        expect(value).toContain("The three stale cards are");
        expect(value).toContain(SUB_AGENT_TRUNCATION_NOTE);
      });

      it("says only that the answer was cut off when there is no text at all", () => {
        const { tool } = createSubAgentTool(baseOptions);

        expect(
          modelText(tool, {
            entries: [],
            text: "",
            truncatedByTokenLimit: true,
          }),
        ).toBe(SUB_AGENT_TRUNCATION_NOTE);
      });

      it("records the cutoff in the log", async () => {
        mockStream.mockResolvedValue({
          fullStream: truncatedStream(),
          text: Promise.resolve(""),
        });

        const { tool } = createSubAgentTool(baseOptions);
        await consumeGenerator(
          tool.execute(
            { task: "Audit the board" },
            {} as ToolExecutionOptions<Record<string, unknown>>,
          ) as AsyncGenerator<SubAgentActivity>,
        );

        expect(vi.mocked(logger.warn).mock.calls[0]?.[0]).toMatchObject({
          subAgentId: "agent-1",
          subAgentName: "Research Agent",
          // The provider's own word for the stop, which the unified reason
          // would otherwise be the only record of.
          rawFinishReason: "max_tokens",
        });
      });

      it("leaves a cleanly finished delegation unflagged", async () => {
        mockStream.mockResolvedValue({
          fullStream: createMockFullStream([
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", text: "All done." },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop" },
          ]),
          text: Promise.resolve(""),
        });

        const { tool } = createSubAgentTool(baseOptions);
        const { yielded } = await consumeGenerator(
          tool.execute(
            { task: "Audit the board" },
            {} as ToolExecutionOptions<Record<string, unknown>>,
          ) as AsyncGenerator<SubAgentActivity>,
        );
        const final = yielded.at(-1)!;

        expect(final).not.toHaveProperty("truncatedByTokenLimit");
        expect(modelText(tool, final)).toBe("All done.");
      });

      // The same rule the run path applies: a step inside the tool loop can end
      // at the ceiling and the sub-agent still recover and answer in full.
      it("ignores a step that ended at the limit mid tool-loop", async () => {
        mockStream.mockResolvedValue({
          fullStream: createMockFullStream([
            { type: "tool-input-start", toolName: "listCards", id: "tc1" },
            { type: "finish-step", finishReason: "length" },
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "listCards",
              output: [{ id: "c1" }],
            },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", text: "One card." },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop" },
          ]),
          text: Promise.resolve(""),
        });

        const { tool } = createSubAgentTool(baseOptions);
        const { yielded } = await consumeGenerator(
          tool.execute(
            { task: "Audit the board" },
            {} as ToolExecutionOptions<Record<string, unknown>>,
          ) as AsyncGenerator<SubAgentActivity>,
        );

        expect(yielded.at(-1)!).not.toHaveProperty("truncatedByTokenLimit");
      });

      // A cutoff is a fact about the answer, not an activity step, so the log
      // the user watches must not gain a spurious row (or a spurious yield).
      it("adds no activity entry and no extra yield for the terminal finish", async () => {
        mockStream.mockResolvedValue({
          fullStream: truncatedStream(),
          text: Promise.resolve(""),
        });

        const { tool } = createSubAgentTool(baseOptions);
        const { yielded } = await consumeGenerator(
          tool.execute(
            { task: "Audit the board" },
            {} as ToolExecutionOptions<Record<string, unknown>>,
          ) as AsyncGenerator<SubAgentActivity>,
        );

        // text-start yields once; the delta and the finish yield nothing; then
        // the final value.
        expect(yielded).toHaveLength(2);
        expect(yielded.at(-1)!.entries).toHaveLength(1);
      });

      // A stream that fails after hitting the ceiling is still a failure: the
      // parent must get a tool error, not a flagged partial answer.
      it("still throws when the stream also reported a failure", async () => {
        mockStream.mockResolvedValue({
          fullStream: createMockFullStream([
            { type: "finish", finishReason: "length" },
            { type: "error", error: new Error("upstream reset") },
          ]),
          text: Promise.resolve(""),
        });

        const { tool } = createSubAgentTool(baseOptions);

        await expect(
          consumeGenerator(
            tool.execute(
              { task: "Audit the board" },
              {} as ToolExecutionOptions<Record<string, unknown>>,
            ) as AsyncGenerator<SubAgentActivity>,
          ),
        ).rejects.toThrow(/upstream reset/);
      });
    });

    it("marks tool-call entry as error on tool-error event", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "tool-input-start", toolName: "web-fetch", id: "tc1" },
          {
            type: "tool-error",
            toolCallId: "tc1",
            toolName: "web-fetch",
            error: "Connection refused",
          },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Do something" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      const { yielded } = await consumeGenerator(gen);

      // Second yield: tool-call with error status
      expect(yielded[1].entries[0]).toEqual({
        type: "tool-call",
        toolName: "web-fetch",
        status: "error",
        error: "Connection refused",
      });
    });

    // Issue #421: the activity entry keeps only the error text, so a sub-agent
    // run — the least observable surface there is — recorded nothing about the
    // arguments the model actually emitted.
    it("logs what the model emitted for a rejected tool call", async () => {
      const raw = '{"url":"https://example.com/a-page","selecto';
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "tool-input-start", toolName: "web-fetch", id: "tc1" },
          {
            type: "tool-error",
            toolCallId: "tc1",
            toolName: "web-fetch",
            input: raw,
            error: "AI_InvalidToolInputError: Invalid input for tool web-fetch",
          },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      await consumeGenerator(
        tool.execute(
          { task: "Do something" },
          {} as ToolExecutionOptions<Record<string, unknown>>,
        ) as AsyncGenerator<SubAgentActivity>,
      );

      // The same message the run driver logs, so an Operator greps once and
      // the sub-agent fields say which run it came from.
      const logged = vi
        .mocked(logger.debug)
        .mock.calls.find((call) => call[1] === "Tool call failed");
      expect(logged?.[0]).toMatchObject({
        subAgentId: "agent-1",
        subAgentName: "Research Agent",
        toolCallId: "tc1",
        toolName: "web-fetch",
        inputType: "string",
        inputKind: "unparseable",
        inputLength: raw.length,
        inputPrefix: raw,
      });
    });

    it("says nothing about a sub-agent tool call that succeeded", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "tool-input-start", toolName: "web-fetch", id: "tc1" },
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "web-fetch",
            input: { url: "https://example.com" },
            output: "page text",
          },
        ]),
        text: Promise.resolve(""),
      });

      const { tool } = createSubAgentTool(baseOptions);
      await consumeGenerator(
        tool.execute(
          { task: "Do something" },
          {} as ToolExecutionOptions<Record<string, unknown>>,
        ) as AsyncGenerator<SubAgentActivity>,
      );

      expect(vi.mocked(logger.debug)).not.toHaveBeenCalled();
    });

    it("passes abortSignal to agent.stream", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([]),
        text: Promise.resolve("done"),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const abortController = new AbortController();
      const gen = tool.execute({ task: "Do something" }, {
        abortSignal: abortController.signal,
      } as ToolExecutionOptions<
        Record<string, unknown>
      >) as AsyncGenerator<SubAgentActivity>;

      await consumeGenerator(gen);

      expect(mockStream).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Do something",
          abortSignal: abortController.signal,
        }),
      );
    });

    it("accumulates entries across multiple events", async () => {
      mockStream.mockResolvedValue({
        fullStream: createMockFullStream([
          { type: "tool-input-start", toolName: "search", id: "tc1" },
          { type: "tool-input-start", toolName: "fetch", id: "tc2" },
        ]),
        text: Promise.resolve("done"),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Do something" },
        {} as ToolExecutionOptions<Record<string, unknown>>,
      ) as AsyncGenerator<SubAgentActivity>;

      const { yielded } = await consumeGenerator(gen);

      // First yield should have 1 entry, second should have 2
      expect(yielded[0].entries).toHaveLength(1);
      expect(yielded[1].entries).toHaveLength(2);
    });
  });

  // Regression for #321 recurring one level down. The parent turn normalizes
  // tool results in `wrapToolsWithBump`, but a sub-agent's own tools go from
  // `loadTools` straight into its ToolLoopAgent. A raw Drizzle `Date` then
  // fails the sub-agent's next-step prompt validation and kills its stream.
  // An Agent must generate with the parameters assigned to it wherever it
  // runs. Before this, a delegated run passed only model/instructions/tools/
  // stopWhen, so an Agent's Temperature was inert the moment it was used as a
  // sub-agent — on every Provider, including ones that honour it.
  describe("sampling parameters", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    const settingsPassedToAgent = () =>
      agentConstructorSpy.mock.calls[0][0] as Record<string, unknown>;

    it("passes the sub-agent's own sampling parameters to its agent", () => {
      createSubAgentTool({
        ...baseOptions,
        sampling: { temperature: 0.2, topP: 0.9, seed: 42 },
      });

      expect(settingsPassedToAgent()).toMatchObject({
        temperature: 0.2,
        topP: 0.9,
        seed: 42,
      });
    });

    it("omits parameters that were never set rather than sending undefined", () => {
      createSubAgentTool({ ...baseOptions, sampling: { temperature: 0.2 } });

      const settings = settingsPassedToAgent();
      expect(settings).toMatchObject({ temperature: 0.2 });
      for (const key of [
        "topP",
        "topK",
        "seed",
        "presencePenalty",
        "frequencyPenalty",
      ]) {
        expect(settings).not.toHaveProperty(key);
      }
    });

    // The ceiling is not a sampling parameter — it comes off the sub-agent's
    // OWN Provider model entry, not its Agent row (issue #454). Without it a
    // delegated run truncates one level down, on Bedrock especially, with the
    // Org Admin's declared ceiling applying only to the parent turn.
    it("passes the sub-agent model's output ceiling to its agent", () => {
      createSubAgentTool({ ...baseOptions, maxOutputTokens: 64000 });

      expect(settingsPassedToAgent()).toMatchObject({
        maxOutputTokens: 64000,
      });
    });

    it("sends no ceiling when the sub-agent's model declares none", () => {
      createSubAgentTool({ ...baseOptions });

      expect(settingsPassedToAgent()).not.toHaveProperty("maxOutputTokens");
    });

    it("cannot have sampling override the model, instructions or tools", () => {
      createSubAgentTool({
        ...baseOptions,
        instructions: "Stay on task.",
        sampling: { temperature: 0.2 },
      });

      const settings = settingsPassedToAgent();
      expect(settings.model).toBe("mock-model");
      expect(settings.instructions).toContain("Stay on task.");
    });
  });

  describe("sub-agent tool results", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    type ExecutableTool = {
      execute: (args: unknown, opts: unknown) => unknown;
    };

    const toolPassedToAgent = (name: string) => {
      const { tools } = agentConstructorSpy.mock.calls[0][0] as {
        tools: Record<string, ExecutableTool>;
      };
      return tools[name];
    };

    it("normalizes Date values out of an async tool result", async () => {
      const createdAt = new Date("2026-08-06T00:00:00.000Z");
      createSubAgentTool({
        ...baseOptions,
        tools: {
          listBoards: {
            execute: () => Promise.resolve([{ id: "b1", createdAt }]),
          } as never,
        },
      });

      const result = await toolPassedToAgent("listBoards").execute({}, {});
      expect(result).toEqual([
        { id: "b1", createdAt: createdAt.toISOString() },
      ]);
    });

    it("normalizes a synchronous tool result too", () => {
      createSubAgentTool({
        ...baseOptions,
        tools: {
          now: {
            execute: () => ({ at: new Date("2026-08-06T00:00:00.000Z") }),
          } as never,
        },
      });

      expect(toolPassedToAgent("now").execute({}, {})).toEqual({
        at: "2026-08-06T00:00:00.000Z",
      });
    });

    it("leaves a tool without an execute function alone", () => {
      const bare = { description: "no execute" } as never;
      createSubAgentTool({ ...baseOptions, tools: { bare } });
      expect(toolPassedToAgent("bare")).toBe(bare);
    });
  });

  describe("toModelOutput", () => {
    it("extracts text from activity output", () => {
      const { tool } = createSubAgentTool(baseOptions);
      const result = tool.toModelOutput!({
        toolCallId: "tc1",
        input: { task: "test" },
        output: { entries: [], text: "Final answer" },
      });
      expect(result).toEqual({ type: "text", value: "Final answer" });
    });

    it("returns fallback when output has no text", () => {
      const { tool } = createSubAgentTool(baseOptions);
      const result = tool.toModelOutput!({
        toolCallId: "tc1",
        input: { task: "test" },
        output: { entries: [] },
      });
      expect(result).toEqual({ type: "text", value: "Task completed." });
    });

    it("returns fallback when output is null", () => {
      const { tool } = createSubAgentTool(baseOptions);
      const result = tool.toModelOutput!({
        toolCallId: "tc1",
        input: { task: "test" },
        output: null as unknown as SubAgentActivity,
      });
      expect(result).toEqual({ type: "text", value: "Task completed." });
    });
  });
});

describe("createSubAgentTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty object when given no sub-agents", async () => {
    const result = await createSubAgentTools([], vi.fn(), vi.fn());
    expect(result).toEqual({ tools: {}, failures: [] });
  });

  it("creates tools for each sub-agent", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Research",
        providerId: "p1",
        modelId: "m1",
        toolSetIds: ["ts1"],
      },
      {
        id: "sa-2",
        name: "Coder",
        providerId: "p1",
        modelId: "m1",
        toolSetIds: [],
      },
    ];

    const createModelFn = vi
      .fn()
      .mockResolvedValue({ model: {}, securityGuardrails: null });
    const loadToolsFn = vi.fn().mockResolvedValue({});

    const result = await createSubAgentTools(
      subAgents,
      createModelFn,
      loadToolsFn,
    );

    expect(Object.keys(result.tools)).toHaveLength(2);
    expect(result.tools).toHaveProperty("delegateToResearch");
    expect(result.tools).toHaveProperty("delegateToCoder");
    expect(result.failures).toEqual([]);
    expect(createModelFn).toHaveBeenCalledTimes(2);
    expect(loadToolsFn).toHaveBeenCalledTimes(2);
  });

  // The ceiling belongs to the sub-agent's own (Provider, model) pair, which
  // only the resolver has, so it rides back with the model it applies to.
  it("forwards the resolved model's output ceiling to the sub-agent's agent", async () => {
    const createModelFn = vi.fn().mockResolvedValue({
      model: {},
      securityGuardrails: null,
      maxOutputTokens: 32000,
    });

    await createSubAgentTools(
      [{ id: "sa-1", name: "Research", providerId: "p1", modelId: "m1" }],
      createModelFn,
      vi.fn().mockResolvedValue({}),
    );

    expect(agentConstructorSpy.mock.calls[0][0]).toMatchObject({
      maxOutputTokens: 32000,
    });
  });

  it("continues when a sub-agent fails to initialize, and reports it as a failure", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Failing",
        providerId: "p1",
        modelId: "m1",
      },
      {
        id: "sa-2",
        name: "Working",
        providerId: "p1",
        modelId: "m1",
      },
    ];

    const createModelFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Model not found"))
      .mockResolvedValueOnce({ model: {}, securityGuardrails: null });
    const loadToolsFn = vi.fn().mockResolvedValue({});

    const result = await createSubAgentTools(
      subAgents,
      createModelFn,
      loadToolsFn,
    );

    expect(Object.keys(result.tools)).toHaveLength(1);
    expect(result.tools).toHaveProperty("delegateToWorking");
    // The dropped sub-agent must come back named, so the caller can stop
    // advertising a tool it never registered.
    expect(result.failures).toEqual([
      { id: "sa-1", name: "Failing", reason: "Model not found" },
    ]);
  });

  it("uses default maxSteps when not provided", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Agent",
        providerId: "p1",
        modelId: "m1",
        maxSteps: null,
      },
    ];

    const createModelFn = vi
      .fn()
      .mockResolvedValue({ model: {}, securityGuardrails: null });
    const loadToolsFn = vi.fn().mockResolvedValue({});

    const result = await createSubAgentTools(
      subAgents,
      createModelFn,
      loadToolsFn,
    );

    expect(Object.keys(result.tools)).toHaveLength(1);
    expect(stepCeilingOf(0)).toBe(DEFAULT_AGENT_MAX_STEPS);
  });

  // A delegated Agent runs on its own ceiling, not the parent's and not the
  // fallback — the whole point of reading `maxSteps` off the row.
  it("forwards an explicit maxSteps instead of the fallback default", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Agent",
        providerId: "p1",
        modelId: "m1",
        maxSteps: 3,
      },
    ];

    const createModelFn = vi
      .fn()
      .mockResolvedValue({ model: {}, securityGuardrails: null });
    const loadToolsFn = vi.fn().mockResolvedValue({});

    await createSubAgentTools(subAgents, createModelFn, loadToolsFn);

    expect(stepCeilingOf(0)).toBe(3);
  });

  it("forwards each sub-agent's stored sampling parameters, treating null as unset", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Tuned",
        providerId: "p1",
        modelId: "m1",
        temperature: 0.3,
        seed: 7,
        // Cleared in the UI writes null, which must mean "use the Provider
        // default" rather than being sent as an explicit value (#263).
        topP: null,
      },
    ];

    const createModelFn = vi
      .fn()
      .mockResolvedValue({ model: {}, securityGuardrails: null });
    const loadToolsFn = vi.fn().mockResolvedValue({});

    await createSubAgentTools(subAgents, createModelFn, loadToolsFn);

    const settings = agentConstructorSpy.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(settings).toMatchObject({ temperature: 0.3, seed: 7 });
    expect(settings).not.toHaveProperty("topP");
  });

  it("passes each sub-agent's own provider security text into its instructions", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Guarded",
        providerId: "p1",
        modelId: "m1",
        instructions: "You are guarded.",
      },
    ];

    const createModelFn = vi.fn().mockResolvedValue({
      model: {},
      securityGuardrails: "Provider-specific rule.",
    });
    const loadToolsFn = vi.fn().mockResolvedValue({});

    await createSubAgentTools(subAgents, createModelFn, loadToolsFn);

    const { instructions } = agentConstructorSpy.mock.calls[0][0] as {
      instructions: string;
    };
    expect(instructions).toContain("You are guarded.");
    expect(instructions).toContain("## Security and trust");
    expect(instructions).toContain("Provider-specific rule.");
  });
});
