import { ToolLoopAgent, tool, readUIMessageStream, type Tool } from "ai";
import { z } from "zod";

/**
 * Options for creating a sub-agent tool.
 */
interface SubAgentToolOptions {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model: any; // LanguageModel from AI SDK
  tools: Record<string, Tool>;
  maxSteps?: number;
}

/**
 * Creates a server-side tool that executes a sub-agent using ToolLoopAgent.
 * The sub-agent runs within the parent's tool execution and returns results directly.
 *
 * @param options Sub-agent configuration including model, tools, and prompts
 * @returns A tool that can be used by the parent agent to delegate tasks
 */
export const createSubAgentTool = (options: SubAgentToolOptions) => {
  const {
    id,
    name,
    description,
    systemPrompt,
    model,
    tools,
    maxSteps = 50,
  } = options;

  // Create the ToolLoopAgent instance
  const agent = new ToolLoopAgent({
    model,
    instructions:
      systemPrompt ||
      `You are a specialized sub-agent named "${name}". Complete the task you are given thoroughly and accurately.`,
    tools,
  });

  // Generate a slugified tool name (e.g., "delegate_to_research_agent")
  const toolName = `delegate_to_${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")}`;

  return {
    toolName,
    tool: tool({
      description: description
        ? `Delegate a task to the "${name}" sub-agent: ${description}`
        : `Delegate a task to the "${name}" sub-agent.`,
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "A fully self-contained task description. Include ALL necessary context, constraints, and requirements directly. The task must be understandable without any prior conversation context.",
          ),
      }),
      execute: async function* ({ task }, { abortSignal }) {
        // Stream the sub-agent's execution
        const result = await agent.stream({
          prompt: task,
          abortSignal,
        });

        // Use readUIMessageStream to accumulate stream into full UIMessage
        // This ensures toModelOutput receives a complete message with all text parts
        for await (const message of readUIMessageStream({
          stream: result.toUIMessageStream(),
        })) {
          yield message;
        }
      },
      toModelOutput: ({ output }) => {
        // Extract the final text response from the sub-agent's output
        // The output is the last message from the sub-agent
        if (output && typeof output === "object") {
          // For UI messages, find the last text part
          if ("parts" in output && Array.isArray(output.parts)) {
            const lastText = output.parts
              .filter((p: any) => p.type === "text")
              .pop();
            if (lastText?.text) {
              return { type: "text", value: lastText.text };
            }
          }
          // Fallback for other message formats
          if ("content" in output && typeof output.content === "string") {
            return { type: "text", value: output.content };
          }
        }
        return { type: "text", value: "Task completed." };
      },
    }),
  };
};

/**
 * Creates sub-agent tools for all sub-agents assigned to a parent agent.
 * Each sub-agent becomes its own tool that the parent can call.
 *
 * @param subAgents List of sub-agent configurations from the database
 * @param createModelFn Factory function to create a model instance for a sub-agent
 * @param loadToolsFn Async function to load tools for a sub-agent
 * @returns Array of {toolName, tool} objects to add to the parent's tools
 */
export const createSubAgentTools = async (
  subAgents: Array<{
    id: string;
    name: string;
    description?: string | null;
    systemPrompt?: string | null;
    providerId: string;
    modelId: string;
    toolSetIds?: string[] | null;
    maxSteps?: number | null;
  }>,
  createModelFn: (providerId: string, modelId: string) => Promise<any>,
  loadToolsFn: (toolSetIds: string[]) => Promise<Record<string, Tool>>,
): Promise<Record<string, Tool>> => {
  const tools: Record<string, Tool> = {};

  for (const subAgent of subAgents) {
    try {
      // Get the sub-agent's model
      const model = await createModelFn(subAgent.providerId, subAgent.modelId);

      // Load the sub-agent's tools
      const subAgentTools = await loadToolsFn(subAgent.toolSetIds || []);

      // Create the tool
      const { toolName, tool } = createSubAgentTool({
        id: subAgent.id,
        name: subAgent.name,
        description: subAgent.description || undefined,
        systemPrompt: subAgent.systemPrompt || undefined,
        model,
        tools: subAgentTools,
        maxSteps: subAgent.maxSteps || 50,
      });

      tools[toolName] = tool;
    } catch (error) {
      console.error(
        `Failed to create sub-agent tool for "${subAgent.name}":`,
        error,
      );
      // Continue with other sub-agents even if one fails
    }
  }

  return tools;
};
