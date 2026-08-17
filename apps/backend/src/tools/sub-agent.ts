import { randomUUID } from "node:crypto";
import { getToolOrDynamicToolName, isToolUIPart, tool, type Tool } from "ai";
import { z } from "zod";
import { logger } from "../logger.ts";
import { startRun } from "../runs/run-lifecycle.ts";
import { driveDelegate, failBeforeDrive } from "../runs/drive.ts";
import type { RunPlan } from "../runs/run-plan.ts";
import { runRegistry } from "../runs/run-registry.ts";
import { describeSdkError } from "../runs/stream-error.ts";
import type { ParentRunContext } from "../runs/types.ts";
import { renderSecurityGuardrails } from "../security-prompt.ts";
import { actorUserId, workspaceScopeForSubAgent } from "../scope.ts";
import { wrapToolsWithActivity } from "../services/tool-activity.ts";
import type { PlatypusUIMessage } from "../types.ts";

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
 * Projects the delegate's in-progress assistant message onto the activity log
 * the parent's UI renders.
 *
 * A projection rather than an event log kept in parallel: the run path already
 * folds every stream part into a `UIMessage`, and reading the entries back off
 * it is what lets a delegated run share that one stream consumer instead of
 * carrying a second switch over the SDK's part types.
 */
const activityEntries = (
  message: PlatypusUIMessage,
): SubAgentActivityEntry[] => {
  const entries: SubAgentActivityEntry[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      entries.push({
        type: "generating",
        status: part.state === "done" ? "completed" : "running",
      });
    } else if (part.type === "reasoning") {
      entries.push({
        type: "thinking",
        status: part.state === "done" ? "completed" : "running",
      });
    } else if (isToolUIPart(part)) {
      const toolName = getToolOrDynamicToolName(part);
      if (part.state === "output-error") {
        entries.push({
          type: "tool-call",
          toolName,
          status: "error",
          error: part.errorText,
        });
      } else {
        entries.push({
          type: "tool-call",
          toolName,
          status: part.state === "output-available" ? "completed" : "running",
        });
      }
    }
  }
  return entries;
};

/**
 * Every text block the delegate produced, across all of its steps.
 *
 * Read off the accumulated message rather than `result.text`, which in AI SDK
 * v7 carries ONLY the final step's text — so a sub-agent whose answer landed in
 * an earlier step, or whose final step is a tool call, came back empty (#324).
 */
const assistantText = (message: PlatypusUIMessage | undefined): string => {
  const blocks: string[] = [];
  for (const part of message?.parts ?? []) {
    if (part.type !== "text") continue;
    const text = part.text.trim();
    if (text) blocks.push(text);
  }
  return blocks.join("\n\n");
};

/** The delegate's last completed tool call, for the no-text fallback. */
const finalToolResult = (
  message: PlatypusUIMessage | undefined,
): ToolResultSummary | undefined => {
  const parts = message?.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (isToolUIPart(part) && part.state === "output-available") {
      return {
        toolName: getToolOrDynamicToolName(part),
        output: part.output,
      };
    }
  }
  return undefined;
};

/**
 * Options for creating a sub-agent tool.
 */
interface SubAgentToolOptions {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  /**
   * This sub-agent's own tools, opened on first delegation rather than supplied
   * up front: a parent that never delegates must not pay for — or warn about —
   * the MCP servers its delegates would have used (the sub-agent's half of the
   * Tool session, see `tool-session.ts`).
   */
  loadTools: () => Promise<Record<string, Tool>>;
  /**
   * Everything THIS sub-agent's own (Provider, model) pair resolved to —
   * model, step ceiling, output ceiling, sampling — via `resolveGenerationPlan`,
   * the one place that decides it. An Agent generates with the parameters
   * assigned to it wherever it runs, so a delegated run is tuned exactly as
   * the same Agent would be on a Chat.
   */
  plan: Omit<RunPlan, "system" | "tools">;
  /**
   * Free-text security directives from THIS sub-agent's resolved provider,
   * appended (non-suppressibly) to its instructions. Null/empty → nothing
   * appended. Sub-agents never call renderSystemPrompt, so this is the only
   * path guardrails reach them (ADR-0016).
   */
  guardrails?: string | null;
  /** The parent run this delegate is invoked from, when there is one. */
  parentRun?: ParentRunContext;
}

/**
 * Creates a server-side tool that runs a sub-agent as a run in its own right.
 *
 * Each invocation registers with `RunRegistry` — so it carries per-step and
 * per-run timeouts, is cancelled when the parent run is, and accumulates
 * `RunStats` — and streams an activity log back to the parent, keeping the SSE
 * connection alive and giving users real-time visibility into sub-agent work.
 *
 * @param options Sub-agent configuration including its generation plan, tools, and prompts
 * @returns A tool that can be used by the parent agent to delegate tasks
 */
export const createSubAgentTool = (options: SubAgentToolOptions) => {
  const {
    id,
    name,
    description,
    instructions,
    loadTools,
    plan,
    guardrails,
    parentRun,
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
  const securityBlock = renderSecurityGuardrails(guardrails);
  const composedInstructions = securityBlock
    ? `${baseInstructions}\n\n${securityBlock}`
    : baseInstructions;

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
        { abortSignal: parentSignal },
      ): AsyncGenerator<SubAgentActivity> {
        // Unique per invocation, not per sub-agent: the same delegate can be
        // called twice in one turn, and two registry entries under one id is a
        // hard error.
        const runId = `sub_${randomUUID()}`;
        // Chained rather than reused: the principal records that this run is a
        // child of `parentRun.runId`, and `actorUserId` still walks back up it
        // to the human the whole tree is executing for.
        const scope = parentRun
          ? workspaceScopeForSubAgent(parentRun.scope, parentRun.runId)
          : undefined;

        // The provider's own word for the ending. The unified reason collapses
        // anything the adapter doesn't recognise, so this is the only record of
        // the actual stop signal (#406).
        let rawFinishReason: string | undefined;

        const run = startRun({
          runId,
          // Inherited, not defaulted: a Trigger run is started under bounds an
          // Operator configured (`TRIGGER_PER_RUN_TIMEOUT_MS` and friends), and
          // work it delegates has to run under the same ones or a long
          // delegation is cut short by a limit nobody chose.
          timeouts: parentRun?.timeouts,
          log: {
            subAgentId: id,
            subAgentName: name,
            parentRunId: parentRun?.runId,
            orgId: scope?.orgId,
            workspaceId: scope?.workspaceId,
            actorUserId: scope ? actorUserId(scope.principal) : undefined,
          },
          onTerminate: ({ status, error, stats }) => {
            logger.info(
              {
                runId,
                subAgentId: id,
                subAgentName: name,
                parentRunId: parentRun?.runId,
                status,
                error: error?.message,
                stats,
              },
              "Sub-agent run finished",
            );
          },
        });

        // Cancelling the parent cancels its delegates. Routed through the
        // registry rather than a linked signal so the delegated run is recorded
        // as cancelled rather than silently disappearing.
        const cancelWithParent = () => runRegistry.cancel(runId);
        parentSignal?.addEventListener("abort", cancelWithParent, {
          once: true,
        });
        // A generator body does not start until the consumer pulls, so the
        // parent can already have been cancelled by the time we get here — in
        // which case the listener will never fire and the delegation would run
        // on regardless.
        if (parentSignal?.aborted) cancelWithParent();

        // Everything below runs inside the registered run, so every exit —
        // including the consumer abandoning this generator mid-stream — reaches
        // the terminal callback and unregisters. `finish` is once-only, so the
        // explicit outcomes below win over the fallback in the `finally`.
        try {
          // The last snapshot seen, which is where the delegate's answer is
          // read from. Whether that answer is safe to hand the parent is the
          // drive's call, not this loop's: a stream that errored ENDS NORMALLY,
          // so `latest` on its own cannot tell a finished answer from the
          // model's opening preamble before a crash. `outcome.failure` can.
          let latest: PlatypusUIMessage | undefined;
          let entries: SubAgentActivityEntry[] = [];
          // Either the drive started or it didn't — one or the other, never
          // neither, so the outcome below needs no fallback for the gap.
          let started:
            | { drive: ReturnType<typeof driveDelegate> }
            | { setupError: string };

          try {
            // Inside the try: opening this delegate's own tools can fail the
            // same way its stream can, and it reaches the parent as a tool error
            // either way rather than an unattributed throw.
            const tools = await loadTools();
            const drive = driveDelegate({
              // A Sub-Agent invocation receives Instructions plus guardrails and
              // nothing else — no workspace context, no memories, no user
              // identity (ADR-0016). The exception is expressed here, in what is
              // handed to the shared drive, rather than as a mode inside the
              // system-prompt renderer.
              plan: {
                ...plan,
                system: composedInstructions,
                // Wrapped per invocation: the wrapper holds THIS run's per-step
                // stall timer down for the duration of each tool call. Results
                // arrive already normalized — the Tool session that loaded them
                // owns that (#321 one level down).
                tools: wrapToolsWithActivity(tools, run.onActivity),
              },
              prompt: task,
              run,
              onStepFinish: (step) => {
                rawFinishReason = step.rawFinishReason;
              },
            });
            started = { drive };
          } catch (error) {
            started = { setupError: describeSdkError(error) };
          }

          // The drive folds the stream; this generator only projects it onto the
          // activity log the parent's UI renders. Serialized entries of the last
          // yield: text deltas and growing tool inputs change the message on
          // nearly every chunk but leave the activity log alone, and yielding for
          // those would spam the parent's SSE stream.
          if ("drive" in started) {
            let lastYielded = "";
            for await (const message of started.drive.snapshots) {
              latest = message;
              entries = activityEntries(message);
              const rendered = JSON.stringify(entries);
              if (rendered === lastYielded) continue;
              lastYielded = rendered;
              yield { entries } satisfies SubAgentActivity;
            }
          }

          // Either the drive ended the run and reported how, or it never
          // started and `failBeforeDrive` ends it under the same rule. Both
          // hand back a decided status, so this tool never derives one.
          const outcome =
            "drive" in started
              ? await started.drive.done
              : await failBeforeDrive(run, started.setupError);

          const aggregatedText = assistantText(latest);
          const truncatedByTokenLimit = outcome.truncated;

          // Throw rather than return: a failed delegation must reach the parent
          // as a tool error, not as a short answer it might summarize and pass
          // off to the user as the sub-agent's finding. Any partial text rides
          // along in the message so the work isn't lost.
          if (outcome.failure) {
            // A delegation stopped because someone cancelled the parent is a
            // normal outcome, not a fault of this sub-agent — log it as the
            // cancellation it is.
            const cancelled = outcome.status === "cancelled";
            logger[cancelled ? "warn" : "error"](
              { runId, subAgentName: name, error: outcome.failure },
              `Sub-agent "${name}" did not finish`,
            );
            // The failure is a step of the work as the parent's UI reads it, so
            // it lands in the log the user is watching before the throw.
            yield {
              entries: [
                ...entries,
                {
                  type: "failed",
                  status: "error",
                  error: outcome.failure,
                },
              ],
            } satisfies SubAgentActivity;
            throw new Error(
              `Sub-agent "${name}" did not complete: ${outcome.failure}` +
                (aggregatedText
                  ? `\n\nPartial output before the failure:\n${aggregatedText}`
                  : ""),
            );
          }

          if (truncatedByTokenLimit) {
            logger.warn(
              { runId, subAgentId: id, subAgentName: name, rawFinishReason },
              `Sub-agent "${name}" answer truncated at the output token limit`,
            );
          }

          const text =
            aggregatedText || summarizeToolResult(finalToolResult(latest));

          // Yield (not return) the final value with text — the SDK's executeTool
          // uses for-await-of which discards generator return values.
          yield {
            entries,
            text,
            // Omitted rather than `false` when the answer is whole, so the flag's
            // presence is the whole of its meaning wherever it is read.
            ...(truncatedByTokenLimit ? { truncatedByTokenLimit: true } : {}),
          } satisfies SubAgentActivity;
        } finally {
          parentSignal?.removeEventListener("abort", cancelWithParent);
          // Reached without an outcome only when nobody consumed the result.
          await run.finish("cancelled");
        }
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

/** What `createSubAgentTools` needs resolved for one sub-agent to build its tool. */
export type SubAgentPlan = {
  plan: Omit<RunPlan, "system" | "tools">;
  guardrails: string | null;
};

/**
 * Creates sub-agent tools for all sub-agents assigned to a parent agent.
 * Each sub-agent becomes its own tool that the parent can call.
 *
 * A sub-agent that fails to initialize is skipped rather than failing the whole
 * turn, and is reported in `failures` so the caller can stop advertising it.
 *
 * `loadToolsFn` is called on a delegate's first invocation rather than here, so
 * building the delegation tools costs no connections. A failure to load them is
 * therefore reported to the parent as a tool error, not as a `failures` entry.
 *
 * `resolvePlan` is expected to be `(subAgent) => resolveGenerationPlan({ agent:
 * subAgent }, scope, queries)` — the same resolver the parent turn's own
 * Agent-or-direct selection goes through (`runs/agent-plan.ts`), so a
 * delegate's model, step ceiling, output ceiling and sampling can never drift
 * from what a Chat turn on that same Agent would resolve to (issues #417,
 * #456, #459). Taken as a callback rather than called directly here so tests
 * can supply a plan without a real Provider row.
 *
 * @param subAgents List of sub-agent configurations from the database
 * @param resolvePlan Resolves one sub-agent to its generation plan and guardrails
 * @param loadToolsFn Async function to load tools for a sub-agent, called lazily
 * @param parentRun The run these delegates will nest inside, when there is one
 * @returns The callable tools keyed by tool name, plus the sub-agents that failed
 */
export const createSubAgentTools = async <
  T extends {
    id: string;
    name: string;
    description?: string | null;
    instructions?: string | null;
    toolSetIds?: string[] | null;
  },
>(
  subAgents: T[],
  resolvePlan: (subAgent: T) => Promise<SubAgentPlan>,
  loadToolsFn: (
    subAgentId: string,
    toolSetIds: string[],
  ) => Promise<Record<string, Tool>>,
  parentRun?: ParentRunContext,
): Promise<{
  tools: Record<string, Tool>;
  failures: SubAgentFailure[];
}> => {
  const tools: Record<string, Tool> = {};
  const failures: SubAgentFailure[] = [];

  for (const subAgent of subAgents) {
    try {
      const { plan, guardrails } = await resolvePlan(subAgent);

      // The sub-agent's tools are opened on its first delegation, not here.
      // Memoized so a delegate called twice in one turn resolves them once.
      let toolsPromise: Promise<Record<string, Tool>> | undefined;
      const loadTools = () =>
        (toolsPromise ??= loadToolsFn(subAgent.id, subAgent.toolSetIds || []));

      // Create the tool
      const { toolName, tool } = createSubAgentTool({
        id: subAgent.id,
        name: subAgent.name,
        description: subAgent.description || undefined,
        instructions: subAgent.instructions || undefined,
        loadTools,
        plan,
        guardrails,
        parentRun,
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
        reason: describeSdkError(error),
      });
    }
  }

  return { tools, failures };
};
