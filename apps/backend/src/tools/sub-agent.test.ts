import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolExecutionOptions } from "ai";
import { createSubAgentTool, createSubAgentTools } from "./sub-agent.ts";
import type { SubAgentActivity } from "./sub-agent.ts";

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

const { mockStream, MockToolLoopAgent, capturedSettings, agentConstructorSpy } =
  vi.hoisted(() => {
    const mockStream = vi.fn();
    const capturedSettings: Record<string, unknown>[] = [];
    const agentConstructorSpy = vi.fn();
    class MockToolLoopAgent {
      instructions: string | undefined;
      constructor(
        settings: Record<string, unknown> & { instructions?: string },
      ) {
        capturedSettings.push(settings);
        agentConstructorSpy(settings);
        this.instructions = settings?.instructions;
      }
      stream = mockStream;
    }
    return {
      mockStream,
      MockToolLoopAgent,
      capturedSettings,
      agentConstructorSpy,
    };
  });

vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    ToolLoopAgent: MockToolLoopAgent,
  };
});

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("createSubAgentTool", () => {
  const baseOptions = {
    id: "agent-1",
    name: "Research Agent",
    // ToolLoopAgent is mocked, so the model value is never used; a string
    // satisfies the `LanguageModel` type without constructing a real provider.
    model: "mock-model",
    tools: {},
  };

  beforeEach(() => {
    capturedSettings.length = 0;
  });

  describe("Tier 2 prepareStep (ADR-0012 §Sub-agents)", () => {
    it("passes prepareStep to ToolLoopAgent when provided", () => {
      const mockPrepareStep = vi.fn();
      createSubAgentTool({ ...baseOptions, prepareStep: mockPrepareStep });
      expect(capturedSettings[0]).toMatchObject({
        prepareStep: mockPrepareStep,
      });
    });

    it("passes undefined prepareStep when not provided", () => {
      createSubAgentTool(baseOptions);
      expect(capturedSettings[0].prepareStep).toBeUndefined();
    });
  });

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
        systemPrompt: "You are a research sub-agent.",
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

    it("appends the security text even when the sub-agent has no systemPrompt (non-suppressible)", () => {
      createSubAgentTool({
        ...baseOptions,
        systemPrompt: undefined,
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
        systemPrompt: "You are a research sub-agent.",
        securityGuardrails: null,
      });
      createSubAgentTool({
        ...baseOptions,
        systemPrompt: "You are a research sub-agent.",
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
    expect(result).toEqual({});
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

    expect(Object.keys(result)).toHaveLength(2);
    expect(result).toHaveProperty("delegateToResearch");
    expect(result).toHaveProperty("delegateToCoder");
    expect(createModelFn).toHaveBeenCalledTimes(2);
    expect(loadToolsFn).toHaveBeenCalledTimes(2);
  });

  it("continues when a sub-agent fails to initialize", async () => {
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

    expect(Object.keys(result)).toHaveLength(1);
    expect(result).toHaveProperty("delegateToWorking");
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

    expect(Object.keys(result)).toHaveLength(1);
  });

  it("threads prepareStepFn to ToolLoopAgent for each sub-agent (ADR-0012 §Sub-agents)", async () => {
    capturedSettings.length = 0;
    const subAgents = [
      { id: "sa-1", name: "Alpha", providerId: "p1", modelId: "m1" },
      { id: "sa-2", name: "Beta", providerId: "p1", modelId: "m1" },
    ];
    const mockStep1 = vi.fn();
    const mockStep2 = vi.fn();
    const prepareStepFn = vi
      .fn()
      .mockImplementation((id: string) =>
        id === "sa-1" ? mockStep1 : mockStep2,
      );

    const createModelFn = vi.fn().mockResolvedValue({});
    const loadToolsFn = vi.fn().mockResolvedValue({});

    await createSubAgentTools(
      subAgents,
      createModelFn,
      loadToolsFn,
      undefined,
      prepareStepFn,
    );

    expect(capturedSettings).toHaveLength(2);
    expect(capturedSettings[0].prepareStep).toBe(mockStep1);
    expect(capturedSettings[1].prepareStep).toBe(mockStep2);
  });

  it("passes each sub-agent's own provider security text into its instructions", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Guarded",
        providerId: "p1",
        modelId: "m1",
        systemPrompt: "You are guarded.",
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
