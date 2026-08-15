import {
  stepCountIs,
  tool,
  ToolLoopAgent,
  type LanguageModel,
  type Tool,
} from "ai";
import { z } from "zod";
import { logger } from "../logger.ts";
import { describeToolInput } from "../rejected-tool-input.ts";
import { isTruncatedByTokenLimit } from "../runs/stream-error.ts";
import { renderSecurityGuardrails } from "../security-prompt.ts";
import { withNormalizedResults } from "../services/tool-result.ts";
import {
  resolveSamplingSettings,
  type SamplingSettings,
  type SamplingSource,
} from "../services/sampling-settings.ts";
import { DEFAULT_AGENT_MAX_STEPS } from "@platypus/schemas";

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
  type: "tool-call" | "thinking" | "generating" | "failed";
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
  /**
   * Set when the sub-agent's terminal finish hit its model's output ceiling, so
   * `text` is a fragment. Named as the run path names the same fact on a Chat
   * message, because it is the same fact one level down.
   */
  truncatedByTokenLimit?: true;
};

/**
 * What the parent Agent is told when a delegate's answer stopped at the output
 * ceiling. Addressed to the model, not the user: the parent is the one that
 * would otherwise summarise the fragment and present it as the finding.
 * Exported so tests assert the behaviour without restating the prose.
 */
export const SUB_AGENT_TRUNCATION_NOTE =
  "[Incomplete: the sub-agent stopped at its model's output token limit, so the answer above breaks off part-way. Treat it as partial — do not present it as the sub-agent's complete finding. Delegate the remainder as a narrower task if you need it.]";

/** The subset of a streamed tool-result part used to synthesize a fallback answer. */
type ToolResultSummary = { toolName?: string; output: unknown };

/**
 * Builds a fallback answer from the sub-agent's final tool result for the case
 * where the sub-agent produced no assistant text at all (e.g. its loop ended on
 * the tool call). Keeps the delegation result meaningful to the parent rather
 * than silently empty. Returns "" when there is no tool result to summarize —
 * `toModelOutput` then supplies its own generic fallback.
 */
/**
 * Renders an unknown thrown/streamed value as a one-line message. `String(...)`
 * alone turns a plain object into "[object Object]", which is exactly the kind
 * of uninformative error this module exists to stop producing.
 */
const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};

const summarizeToolResult = (
  toolResult: ToolResultSummary | undefined,
): string => {
  if (!toolResult) return "";
  const { toolName, output } = toolResult;
  const rendered = typeof output === "string" ? output : JSON.stringify(output);
  const label = toolName ? `${toolName} result` : "Tool result";
  return `${label}: ${rendered}`;
};

/**
 * Options for creating a sub-agent tool.
 */
interface SubAgentToolOptions {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  model: LanguageModel;
  tools: Record<string, Tool>;
  maxSteps?: number;
  /**
   * Free-text security directives from THIS sub-agent's resolved provider,
   * appended (non-suppressibly) to its instructions. Null/empty → nothing
   * appended. Sub-agents never call renderSystemPrompt, so this is the only
   * path guardrails reach them.
   */
  securityGuardrails?: string | null;
  /**
   * THIS sub-agent's own sampling parameters, already narrowed to the ones set.
   * An Agent generates with the parameters assigned to it wherever it runs, so
   * a delegated run is tuned exactly as the same Agent would be on a Chat.
   */
  sampling?: SamplingSettings;
  /**
   * The output ceiling THIS sub-agent's model declares, or undefined for none
   * (issue #454). Not a sampling parameter: it comes off the sub-agent's own
   * Provider model entry rather than its Agent row, which is why it arrives
   * separately from `sampling`. Omitted when undefined so the SDK is passed
   * nothing at all.
   */
  maxOutputTokens?: number;
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
    instructions,
    model,
    tools,
    maxSteps = DEFAULT_AGENT_MAX_STEPS,
    securityGuardrails,
    sampling,
    maxOutputTokens,
    onProgress,
  } = options;

  const toolName = subAgentToolName({ name });

  // Append the provider's security directives to the base instructions —
  // whether those come from the sub-agent's own instructions OR the canned
  // fallback. Appending only to the sub-agent's own instructions would silently
  // drop guardrails for instruction-less sub-agents, breaking the
  // non-suppressible guarantee.
  const baseInstructions =
    instructions ||
    `You are a specialized sub-agent named "${name}". Complete the task you are given thoroughly and accurately.`;
  const securityBlock = renderSecurityGuardrails(securityGuardrails);
  const composedInstructions = securityBlock
    ? `${baseInstructions}\n\n${securityBlock}`
    : baseInstructions;

  const agent = new ToolLoopAgent({
    ...sampling,
    // Spread rather than assigned, so an undeclared ceiling leaves the key off
    // entirely instead of sending `maxOutputTokens: undefined`.
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    model,
    instructions: composedInstructions,
    // The sub-agent's own tools never pass through the parent turn's
    // `wrapToolsWithBump`, so #321 recurs one level down: a raw Drizzle `Date`
    // in a tool result fails the sub-agent's next-step prompt validation and
    // kills its stream mid-run.
    tools: withNormalizedResults(tools),
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
      // The yield type is stated rather than inferred: an optional key present
      // on only some of the yields makes the inferred union unreadable by
      // `toModelOutput`, which sees every yield as a possible tool output.
      execute: async function* (
        { task },
        { abortSignal },
      ): AsyncGenerator<SubAgentActivity> {
        const result = await agent.stream({ prompt: task, abortSignal });
        const entries: SubAgentActivityEntry[] = [];

        // Accumulate the sub-agent's assistant text off the stream, keyed by
        // text-block id. In AI SDK v7 `result.text` carries ONLY the final
        // step's text, so a sub-agent whose answer landed in an earlier step —
        // or whose final step is a tool call — comes back empty (#324). Reading
        // text-deltas from the fullStream captures every step's output in order.
        const textBlocks = new Map<string, string>();
        // Last tool result, used to synthesize a meaningful fallback when the
        // sub-agent produced no assistant text at all.
        let lastToolResult: ToolResultSummary | undefined;
        // Set when the sub-agent's own stream reports a failure. The stream
        // ENDS NORMALLY after an error part, so without this the generator
        // would return whatever text had accumulated — typically the model's
        // opening preamble — and the parent would read a crash as an answer.
        let streamFailure: string | undefined;
        // Set when the delegate ran out of output budget. Unlike the two above
        // this is not a failure — the text is real work — but the stream ends
        // normally either way, so without reading the finish reason a fragment
        // is indistinguishable from a finished answer (#442).
        let truncatedByTokenLimit = false;
        // What the provider itself called the ending. The unified reason
        // collapses anything the adapter doesn't recognise, so this is the only
        // record of the actual stop signal (#406), and a delegated run has no
        // other observable surface at all.
        let rawFinishReason: string | undefined;

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
              lastToolResult = {
                toolName: part.toolName,
                output: part.output,
              };
              break;
            case "tool-error": {
              const entry = entries.findLast(
                (e) => e.type === "tool-call" && e.status === "running",
              );
              if (entry) {
                entry.status = "error";
                entry.error = String(part.error);
              }
              // The activity entry keeps only the error text, so without this
              // the arguments the sub-agent emitted are gone. A sub-agent run
              // is the least observable surface there is, which is where the
              // record is worth the most (issue #421). `debug`, because tool
              // arguments are model and user data.
              logger.debug(
                {
                  subAgentId: id,
                  subAgentName: name,
                  ...describeToolInput(part),
                },
                "Tool call failed",
              );
              break;
            }
            case "reasoning-start":
              entries.push({ type: "thinking", status: "running" });
              break;
            case "reasoning-end":
              completeLastRunning("thinking");
              break;
            case "text-start":
              textBlocks.set(part.id, "");
              entries.push({ type: "generating", status: "running" });
              break;
            case "text-delta":
              textBlocks.set(
                part.id,
                (textBlocks.get(part.id) ?? "") + part.text,
              );
              // Deltas grow the answer but don't change the activity log, so
              // they must not trigger a yield (would spam the SSE stream).
              changed = false;
              break;
            case "text-end":
              completeLastRunning("generating");
              break;
            case "error":
              streamFailure = describeError(part.error);
              entries.push({
                type: "failed",
                status: "error",
                error: streamFailure,
              });
              break;
            // The terminal finish only, as on the run path: a step inside the
            // tool loop can end at the ceiling and the sub-agent still recover
            // and answer in full. A cutoff is a fact about the answer rather
            // than a step of the work, so it adds no activity entry — hence no
            // yield either.
            case "finish":
              truncatedByTokenLimit = isTruncatedByTokenLimit(
                part.finishReason,
              );
              rawFinishReason = part.rawFinishReason;
              changed = false;
              break;
            case "abort":
              streamFailure = part.reason
                ? `Stopped before finishing: ${part.reason}`
                : "Stopped before finishing.";
              entries.push({
                type: "failed",
                status: "error",
                error: streamFailure,
              });
              break;
            default:
              changed = false;
          }

          if (changed) {
            onProgress?.();
            yield { entries } satisfies SubAgentActivity;
          }
        }

        const aggregatedText = Array.from(textBlocks.values())
          .map((t) => t.trim())
          .filter(Boolean)
          .join("\n\n");

        // Throw rather than return: a failed delegation must reach the parent
        // as a tool error, not as a short answer it might summarize and pass
        // off to the user as the sub-agent's finding. Any partial text rides
        // along in the message so the work isn't lost.
        if (streamFailure) {
          logger.error(
            { subAgentName: name, error: streamFailure },
            `Sub-agent "${name}" stream failed`,
          );
          throw new Error(
            `Sub-agent "${name}" did not complete: ${streamFailure}` +
              (aggregatedText
                ? `\n\nPartial output before the failure:\n${aggregatedText}`
                : ""),
          );
        }

        const text = aggregatedText || summarizeToolResult(lastToolResult);

        if (truncatedByTokenLimit) {
          logger.warn(
            { subAgentId: id, subAgentName: name, rawFinishReason },
            `Sub-agent "${name}" answer truncated at the output token limit`,
          );
        }

        // Yield (not return) the final value with text — the SDK's executeTool
        // uses for-await-of which discards generator return values.
        yield {
          entries,
          text,
          // Omitted rather than `false` when the answer is whole, so the flag's
          // presence is the whole of its meaning wherever it is read.
          ...(truncatedByTokenLimit ? { truncatedByTokenLimit: true } : {}),
        } satisfies SubAgentActivity;
      },
      toModelOutput: ({ output }) => {
        const value = output?.text ?? "Task completed.";
        return {
          type: "text" as const,
          // Annotated rather than thrown: the fragment is real work the parent
          // can still use, and the run path treats a cutoff as a fact to record
          // rather than a failure. What it must not do is read as complete.
          value: output?.truncatedByTokenLimit
            ? `${value}\n\n${SUB_AGENT_TRUNCATION_NOTE}`.trim()
            : value,
        };
      },
    }),
  };
};

/**
 * A sub-agent that could not be turned into a callable tool this turn.
 * Returned — not just logged — because the caller has to keep the system
 * prompt in step with the toolset: describing a delegation tool that was never
 * registered makes the model call it and take an `AI_NoSuchToolError`.
 *
 * `name` is optional because the caller also reports assignments whose row never
 * resolved in the invoking Workspace; those have only the assigned `id`, which is
 * the one identifier available without crossing the boundary that dropped them.
 */
export type SubAgentFailure = { id: string; name?: string; reason: string };

/**
 * Creates sub-agent tools for all sub-agents assigned to a parent agent.
 * Each sub-agent becomes its own tool that the parent can call.
 *
 * A sub-agent that fails to initialize is skipped rather than failing the whole
 * turn, and is reported in `failures` so the caller can stop advertising it.
 *
 * @param subAgents List of sub-agent configurations from the database
 * @param createModelFn Factory function to create a model instance for a sub-agent
 * @param loadToolsFn Async function to load tools for a sub-agent
 * @returns The callable tools keyed by tool name, plus the sub-agents that failed
 */
export const createSubAgentTools = async (
  subAgents: Array<
    {
      id: string;
      name: string;
      description?: string | null;
      instructions?: string | null;
      providerId: string;
      modelId: string;
      toolSetIds?: string[] | null;
      maxSteps?: number | null;
    } & SamplingSource
  >,
  createModelFn: (
    providerId: string,
    modelId: string,
  ) => Promise<{
    model: LanguageModel;
    securityGuardrails: string | null;
    /**
     * The output ceiling the resolved `(Provider, model)` pair declares, if any.
     * Rides back with the model because resolving it needs the sub-agent's own
     * Provider row, which only the caller's resolver has (issue #454).
     */
    maxOutputTokens?: number;
  }>,
  loadToolsFn: (
    subAgentId: string,
    toolSetIds: string[],
  ) => Promise<Record<string, Tool>>,
  onProgress?: () => void,
): Promise<{
  tools: Record<string, Tool>;
  failures: SubAgentFailure[];
}> => {
  const tools: Record<string, Tool> = {};
  const failures: SubAgentFailure[] = [];

  for (const subAgent of subAgents) {
    try {
      // Get the sub-agent's model, its provider's security directives, and
      // the output ceiling that model declares.
      const { model, securityGuardrails, maxOutputTokens } =
        await createModelFn(subAgent.providerId, subAgent.modelId);

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
        instructions: subAgent.instructions || undefined,
        model,
        tools: subAgentTools,
        maxSteps: subAgent.maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
        securityGuardrails,
        sampling: resolveSamplingSettings(subAgent),
        maxOutputTokens,
        onProgress,
      });

      tools[toolName] = tool;
    } catch (error) {
      logger.error(
        { error, subAgentName: subAgent.name, subAgentId: subAgent.id },
        `Failed to create sub-agent tool for "${subAgent.name}"`,
      );
      // Continue with other sub-agents even if one fails
      failures.push({
        id: subAgent.id,
        name: subAgent.name,
        reason: describeError(error),
      });
    }
  }

  return { tools, failures };
};
