import { stepCountIs, tool, ToolLoopAgent, type Tool } from "ai";
import { z } from "zod";
import { logger } from "../logger.ts";

/**
 * Single source of truth for the sub-agent delegation tool name.
 * The slug is "delegateTo<PascalCaseName>" — e.g. "Research Agent" → "delegateToResearchAgent".
 */
export const subAgentToolName = (subAgent: { name: string }): string =>
  `delegateTo${subAgent.name
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "")
    .replace(/^./, (c) => c.toUpperCase())}`;

/**
 * Activity log entry for a sub-agent's execution.
 */
type SubAgentActivityEntry = {
  type: "tool-call" | "thinking" | "generating";
  toolName?: string;
  status: "running" | "completed" | "error";
  error?: string;
};

/**
 * Activity log yielded by a sub-agent tool during execution.
 */
export type SubAgentActivity = {
  entries: SubAgentActivityEntry[];
  text?: string;
};

/**
 * Options for creating a sub-agent tool.
 */
/**
 * Controls how the sub-agent's final response text is returned to the parent
 * agent's context window after the tool call completes.
 *
 * - `'full'` (default): the complete response text. Use when the parent
 *   agent reads and acts on the returned text.
 * - `'none'`: always returns "Task completed." Sub-agents that communicate
 *   results via shared state (files, board cards, databases) should use
 *   this to prevent large outputs (transcripts, API payloads, etc.) from
 *   bloating the parent's context window.
 * - `number`: returns at most this many characters taken from the end of the
 *   response, where agents typically place their summary or status line.
 */
export type SubAgentParentOutput = 'full' | 'none' | number;

/**
 * Parses the DB-stored text representation of parentOutput.
 * Stored as "full", "none", or a stringified positive integer.
 */
export const parseParentOutput = (raw: string | null | undefined): SubAgentParentOutput => {
  if (!raw || raw === 'full') return 'full';
  if (raw === 'none') return 'none';
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 'full';
};

interface SubAgentToolOptions {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model: any; // LanguageModel from AI SDK
  tools: Record<string, Tool>;
  maxSteps?: number;
  parentOutput?: SubAgentParentOutput;
  /** Called on each activity update from the sub-agent. Used to reset the parent run's per-step timeout. */
  onProgress?: () => void;
}

/**
 * Creates a server-side tool that executes a sub-agent using ToolLoopAgent.stream().
 * The sub-agent streams an activity log back to the parent, keeping the SSE
 * connection alive and giving users real-time visibility into sub-agent work.
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
    parentOutput = 'full',
    onProgress,
  } = options;

  const toolName = subAgentToolName({ name });

  const agent = new ToolLoopAgent({
    model,
    instructions:
      systemPrompt ||
      `You are a specialized sub-agent named "${name}". Complete the task you are given thoroughly and accurately.`,
    tools,
    stopWhen: [stepCountIs(maxSteps)],
  });

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
        const result = await agent.stream({ prompt: task, abortSignal });
        const entries: SubAgentActivityEntry[] = [];

        const completeLastRunning = (type: SubAgentActivityEntry["type"]) => {
          const entry = entries.findLast(
            (e) => e.type === type && e.status === "running",
          );
          if (entry) entry.status = "completed";
        };

        for await (const part of result.fullStream) {
          let changed = true;

          switch (part.type) {
            case "tool-input-start":
              entries.push({
                type: "tool-call",
                toolName: part.toolName,
                status: "running",
              });
              break;
            case "tool-result":
              completeLastRunning("tool-call");
              break;
            case "tool-error": {
              const entry = entries.findLast(
                (e) => e.type === "tool-call" && e.status === "running",
              );
              if (entry) {
                entry.status = "error";
                entry.error = String(part.error);
              }
              break;
            }
            case "reasoning-start":
              entries.push({ type: "thinking", status: "running" });
              break;
            case "reasoning-end":
              completeLastRunning("thinking");
              break;
            case "text-start":
              entries.push({ type: "generating", status: "running" });
              break;
            case "text-end":
              completeLastRunning("generating");
              break;
            default:
              changed = false;
          }

          if (changed) {
            onProgress?.();
            yield { entries } satisfies SubAgentActivity;
          }
        }

        // Yield (not return) the final value with text — the SDK's executeTool
        // uses for-await-of which discards generator return values.
        yield { entries, text: await result.text } satisfies SubAgentActivity;
      },
      toModelOutput: ({ output }) => {
        const text = (output as SubAgentActivity)?.text ?? "";
        let value: string;
        if (parentOutput === 'none') {
          value = "Task completed.";
        } else if (typeof parentOutput === 'number') {
          value = text.slice(-parentOutput) || "Task completed.";
        } else {
          value = text || "Task completed.";
        }
        return { type: "text" as const, value };
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
    parentOutput?: string | null;
  }>,
  createModelFn: (providerId: string, modelId: string) => Promise<any>,
  loadToolsFn: (
    subAgentId: string,
    toolSetIds: string[],
  ) => Promise<Record<string, Tool>>,
  onProgress?: () => void,
): Promise<Record<string, Tool>> => {
  const tools: Record<string, Tool> = {};

  for (const subAgent of subAgents) {
    try {
      // Get the sub-agent's model
      const model = await createModelFn(subAgent.providerId, subAgent.modelId);

      // Load the sub-agent's tools
      const subAgentTools = await loadToolsFn(
        subAgent.id,
        subAgent.toolSetIds || [],
      );

      // Create the tool
      const { toolName, tool } = createSubAgentTool({
        id: subAgent.id,
        name: subAgent.name,
        description: subAgent.description || undefined,
        systemPrompt: subAgent.systemPrompt || undefined,
        model,
        tools: subAgentTools,
        maxSteps: subAgent.maxSteps || 50,
        parentOutput: parseParentOutput(subAgent.parentOutput),
        onProgress,
      });

      tools[toolName] = tool;
    } catch (error) {
      logger.error(
        { error, subAgentName: subAgent.name, subAgentId: subAgent.id },
        `Failed to create sub-agent tool for "${subAgent.name}"`,
      );
      // Continue with other sub-agents even if one fails
    }
  }

  return tools;
};
