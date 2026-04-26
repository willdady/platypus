import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubAgentTool, createSubAgentTools } from "./sub-agent.ts";

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

// Mock stream events helper
function createMockFullStream(
  events: Array<{ type: string; [key: string]: any }>,
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

const { mockStream, MockToolLoopAgent } = vi.hoisted(() => {
  const mockStream = vi.fn();
  class MockToolLoopAgent {
    constructor() {}
    stream = mockStream;
  }
  return { mockStream, MockToolLoopAgent };
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
    model: {},
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
          { type: "text-end", id: "t1" },
        ]),
        text: Promise.resolve("Sub-agent result"),
      });

      const { tool } = createSubAgentTool(baseOptions);
      const gen = tool.execute(
        { task: "Do something" },
        {} as any,
      ) as AsyncGenerator<any, any>;

      const { yielded } = await consumeGenerator(gen);

      // Should have yielded 6 activity updates + 1 final with text
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
        {} as any,
      ) as AsyncGenerator<any, any>;

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
      } as any) as AsyncGenerator<any, any>;

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
        {} as any,
      ) as AsyncGenerator<any, any>;

      const { yielded } = await consumeGenerator(gen);

      // First yield should have 1 entry, second should have 2
      expect(yielded[0].entries).toHaveLength(1);
      expect(yielded[1].entries).toHaveLength(2);
    });
  });

  describe("toModelOutput", () => {
    it("extracts text from activity output", () => {
      const { tool } = createSubAgentTool(baseOptions);
      const result = (tool as any).toModelOutput({
        toolCallId: "tc1",
        input: { task: "test" },
        output: { entries: [], text: "Final answer" },
      });
      expect(result).toEqual({ type: "text", value: "Final answer" });
    });

    it("returns fallback when output has no text", () => {
      const { tool } = createSubAgentTool(baseOptions);
      const result = (tool as any).toModelOutput({
        toolCallId: "tc1",
        input: { task: "test" },
        output: { entries: [] },
      });
      expect(result).toEqual({ type: "text", value: "Task completed." });
    });

    it("returns fallback when output is null", () => {
      const { tool } = createSubAgentTool(baseOptions);
      const result = (tool as any).toModelOutput({
        toolCallId: "tc1",
        input: { task: "test" },
        output: null,
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

    const createModelFn = vi.fn().mockResolvedValue({});
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
      .mockResolvedValueOnce({});
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

    const createModelFn = vi.fn().mockResolvedValue({});
    const loadToolsFn = vi.fn().mockResolvedValue({});

    const result = await createSubAgentTools(
      subAgents,
      createModelFn,
      loadToolsFn,
    );

    expect(Object.keys(result)).toHaveLength(1);
  });
});
