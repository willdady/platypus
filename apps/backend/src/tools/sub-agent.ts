import {
  stepCountIs,
  tool,
  ToolLoopAgent,
  wrapLanguageModel,
  type LanguageModel,
  type PrepareStepFunction,
  type Tool,
} from "ai";
import { z } from "zod";
import { logger } from "../logger.ts";
import {
  contextOverflowRecoveryMiddleware,
  type RecoveryContext,
} from "../runs/recovery.ts";

/**
 * Single source of truth for the sub-agent delegation tool name.
 * The slug is "delegateTo<PascalCaseName>" — e.g. "Research Agent" → "delegateToResearchAgent".
 */
export const subAgentToolName = (subAgent: { name: string }): string =>
  `delegateTo${subAgent.name
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase())
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
interface SubAgentToolOptions {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model: LanguageModel;
  tools: Record<string, Tool>;
  maxSteps?: number;
  /** Called on each activity update from the sub-agent. Used to reset the parent run's per-step timeout. */
  onProgress?: () => void;
  /** Tier 2 in-turn compaction callback (§D, drift M3). Null when compaction disabled. */
  prepareStep?: PrepareStepFunction;
  /**
   * Context-overflow recovery (§E, P4) for the sub-agent's own model calls.
   * Sub-agents run a ToolLoopAgent OUTSIDE the parent run's recovery-wrapped
   * model, so without this their only overflow protection is Tier 2 — which
   * fires late (its trigger omits the sub-agent's tool/prompt overhead) and has
   * no net behind it. Wrapping here gives every sub-agent step one trim+retry,
   * matching the main path (C1/B-F3). `markDirty` is omitted (no chat row).
   */
  recovery?: RecoveryContext;
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
    name,
    description,
    systemPrompt,
    model,
    tools,
    maxSteps = 50,
    onProgress,
    prepareStep,
    recovery,
  } = options;

  const toolName = subAgentToolName({ name });

  // Wrap the sub-agent model with the overflow-recovery middleware (C1/B-F3) so
  // a step that overflows gets one trim+retry instead of hard-failing the task.
  // Guard on `typeof model !== "string"`: `wrapLanguageModel` needs a model
  // INSTANCE, and `LanguageModel` permits a bare string id. The factory returns
  // an instance today, but a string would otherwise throw here and the catch in
  // `createSubAgentTools` would silently drop the whole sub-agent — so degrade to
  // the unwrapped model instead. The remaining cast only reconciles the
  // V2/V3 instance union (wrapLanguageModel accepts both at runtime).
  const recoveredModel: LanguageModel =
    recovery && typeof model !== "string"
      ? wrapLanguageModel({
          model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
          middleware: contextOverflowRecoveryMiddleware(recovery),
        })
      : model;

  const agent = new ToolLoopAgent({
    model: recoveredModel,
    instructions:
      systemPrompt ||
      `You are a specialized sub-agent named "${name}". Complete the task you are given thoroughly and accurately.`,
    tools,
    stopWhen: [stepCountIs(maxSteps)],
    prepareStep,
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
      toModelOutput: ({ output }) => ({
        type: "text" as const,
        value: output?.text ?? "Task completed.",
      }),
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
  createModelFn: (
    providerId: string,
    modelId: string,
  ) => Promise<LanguageModel>,
  loadToolsFn: (
    subAgentId: string,
    toolSetIds: string[],
  ) => Promise<Record<string, Tool>>,
  onProgress?: () => void,
  prepareStepFn?: (id: string) => PrepareStepFunction | undefined,
  recoveryFn?: (id: string) => RecoveryContext | undefined,
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
        onProgress,
        prepareStep: prepareStepFn?.(subAgent.id),
        recovery: recoveryFn?.(subAgent.id),
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
