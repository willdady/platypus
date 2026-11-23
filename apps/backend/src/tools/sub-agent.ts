import { randomUUID } from "node:crypto";
import { getToolName, isToolUIPart, tool, type Tool } from "ai";
import { z } from "zod";
import { logger } from "../logger.ts";
import { startRun } from "../runs/run-lifecycle.ts";
import { driveDelegate, failBeforeDrive } from "../runs/drive.ts";
import type { RunPlan } from "../runs/run-plan.ts";
import type { GenerationPlan } from "../runs/agent-plan.ts";
import { runRegistry } from "../runs/run-registry.ts";
import { describeSdkError } from "../runs/stream-error.ts";
import { runEventScopeOf, type RunEventScope } from "../runs/run-events.ts";
import type { ParentRunContext } from "../runs/types.ts";
import { renderSecurityGuardrails } from "../security-prompt.ts";
import { actorUserId, workspaceScopeForSubAgent } from "../scope.ts";
import { wrapToolsWithActivity } from "../services/tool-activity.ts";
import type { PlatypusUIMessage } from "../types.ts";
import type {
  SubAgentActivity,
  SubAgentActivityEntry,
} from "@platypus/schemas";
import { DELEGATE_TOOL_NAME } from "./turn-tool-names.ts";
import type { ToolGateScope } from "../tool-gates/index.ts";

export type LoadedSubAgentTools = {
  tools: Record<string, Tool>;
  readOnlyToolNames: ReadonlySet<string>;
  gateScope: ToolGateScope;
};

export const SUB_AGENT_TRUNCATION_NOTE =
  "[Incomplete: the sub-agent stopped at its model's output token limit, so the answer above breaks off part-way. Treat it as partial — do not present it as the sub-agent's complete finding. Delegate the remainder as a narrower task if you need it.]";

export const SUB_AGENT_STEP_LIMIT_NOTE =
  "[Incomplete: the sub-agent's loop was stopped at its step limit while it was still working, so the result above is as far as it got and may contain no answer at all. Treat it as partial — do not present it as the sub-agent's complete finding. Delegate the remainder as a narrower task if you need it.]";

type ToolResultSummary = { toolName?: string; output: unknown };

const summarizeToolResult = (
  toolResult: ToolResultSummary | undefined,
): string => {
  if (!toolResult) return "";
  const { toolName, output } = toolResult;
  const rendered = typeof output === "string" ? output : JSON.stringify(output);
  const label = toolName ? `${toolName} result` : "Tool result";
  return `${label}: ${rendered}`;
};

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
      const toolName = getToolName(part);
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

const assistantText = (message: PlatypusUIMessage | undefined): string => {
  const blocks: string[] = [];
  for (const part of message?.parts ?? []) {
    if (part.type !== "text") continue;
    const text = part.text.trim();
    if (text) blocks.push(text);
  }
  return blocks.join("\n\n");
};

const finalToolResult = (
  message: PlatypusUIMessage | undefined,
): ToolResultSummary | undefined => {
  const parts = message?.parts ?? [];
  for (const part of [...parts].reverse()) {
    if (isToolUIPart(part) && part.state === "output-available") {
      return {
        toolName: getToolName(part),
        output: part.output,
      };
    }
  }
  return undefined;
};

interface SubAgentDelegateOptions {
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  loadTools: () => Promise<LoadedSubAgentTools>;
  plan: Omit<RunPlan, "system" | "tools">;
  guardrails?: string | null;
  parentRun?: ParentRunContext;
  fallback?: GenerationPlan;
}

export type SubAgentDelegate = {
  id: string;
  name: string;
  description?: string;
  run: (
    task: string,
    options: {
      abortSignal?: AbortSignal;
      events?: RunEventScope;
    },
  ) => AsyncGenerator<SubAgentActivity>;
};

export const createSubAgentDelegate = (
  options: SubAgentDelegateOptions,
): SubAgentDelegate => {
  const {
    id,
    name,
    description,
    instructions,
    loadTools,
    plan,
    guardrails,
    parentRun,
    fallback,
  } = options;

  const baseInstructions =
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
    instructions ||
    `You are a specialized sub-agent named "${name}". Complete the task you are given thoroughly and accurately.`;
  const securityBlock = renderSecurityGuardrails(guardrails);
  const composedInstructions = securityBlock
    ? `${baseInstructions}\n\n${securityBlock}`
    : baseInstructions;

  const fallbackSecurityBlock = fallback
    ? renderSecurityGuardrails(fallback.guardrails)
    : "";
  const fallbackSystem = fallbackSecurityBlock
    ? `${baseInstructions}\n\n${fallbackSecurityBlock}`
    : baseInstructions;

  return {
    id,
    name,
    description,
    run: async function* (
      task,
      { abortSignal: parentSignal, events },
    ): AsyncGenerator<SubAgentActivity> {
      const runId = `sub_${randomUUID()}`;
      const scope = parentRun
        ? workspaceScopeForSubAgent(parentRun.scope, parentRun.runId)
        : undefined;

      let rawFinishReason: string | undefined;

      const run = startRun({
        runId,
        timeouts: parentRun?.timeouts,
        log: {
          subAgentId: id,
          subAgentName: name,
          parentRunId: parentRun?.runId,
          orgId: scope?.orgId,
          workspaceId: scope?.workspaceId,
          actorUserId: scope ? actorUserId(scope.principal) : undefined,
        },
        onStepProgress: (stats) => parentRun?.setDelegateUsage(runId, stats),
        onTerminate: ({ status, error, stats }) => {
          parentRun?.setDelegateUsage(runId, stats);
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

      const cancelWithParent = () => runRegistry.cancel(runId);
      parentSignal?.addEventListener("abort", cancelWithParent, {
        once: true,
      });
      if (parentSignal?.aborted) cancelWithParent();

      try {
        let latest: PlatypusUIMessage | undefined;
        let entries: SubAgentActivityEntry[] = [];
        let started:
          { drive: ReturnType<typeof driveDelegate> } | { setupError: string };

        try {
          const { tools, readOnlyToolNames, gateScope } = await loadTools();
          const drive = driveDelegate({
            agentId: id,
            plan: {
              ...plan,
              system: composedInstructions,
              tools: wrapToolsWithActivity(tools, run.onActivity),
              readOnlyToolNames,
              gateScope,
            },
            prompt: task,
            run,
            ...(fallback
              ? { fallback: { plan: fallback.plan, system: fallbackSystem } }
              : {}),
            onStepFinish: (step) => {
              rawFinishReason = step.rawFinishReason;
            },
            events,
          });
          started = { drive };
        } catch (error) {
          started = { setupError: describeSdkError(error) };
        }

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

        const outcome =
          "drive" in started
            ? await started.drive.done
            : await failBeforeDrive(run, started.setupError);

        const aggregatedText = assistantText(latest);
        const truncatedByTokenLimit = outcome.truncated;
        const stoppedAtStepLimit = outcome.stoppedAtStepLimit;

        if (outcome.failure) {
          const cancelled = outcome.status === "cancelled";
          logger[cancelled ? "warn" : "error"](
            { runId, subAgentName: name, error: outcome.failure },
            `Sub-agent "${name}" did not finish`,
          );
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

        if (stoppedAtStepLimit) {
          logger.warn(
            { runId, subAgentId: id, subAgentName: name, rawFinishReason },
            `Sub-agent "${name}" stopped at its step ceiling with work outstanding`,
          );
        }

        const text =
          aggregatedText || summarizeToolResult(finalToolResult(latest));

        yield {
          entries,
          text,
          ...(truncatedByTokenLimit ? { truncatedByTokenLimit: true } : {}),
          ...(stoppedAtStepLimit ? { stoppedAtStepLimit: true } : {}),
        } satisfies SubAgentActivity;
      } finally {
        parentSignal?.removeEventListener("abort", cancelWithParent);
        // why: finish is once-only; this lands only if the consumer abandons the generator
        await run.finish("cancelled");
      }
    },
  };
};

const targetKey = (name: string): string => name.trim().toLowerCase();

const listTargets = (names: string[]): string =>
  names.map((n) => `"${n}"`).join(", ");

export const createDelegateTool = (
  delegates: SubAgentDelegate[],
  refusals: Map<string, { name: string; reason: string }> = new Map(),
) => {
  const byKey = new Map(delegates.map((d) => [targetKey(d.name), d]));
  const names = delegates.map((d) => d.name);

  return tool({
    description:
      "Delegate a self-contained task to one of your sub-agents. The sub-agents you can delegate to, and what each one is for, are listed in the Sub-Agents section of your instructions.",
    inputSchema: z.object({
      subAgent: z
        .string()
        .describe(
          "The name of the sub-agent to delegate to, exactly as it is listed in the Sub-Agents section of your instructions.",
        ),
      task: z
        .string()
        .describe(
          "A fully self-contained task description. Include ALL necessary context, constraints, and requirements directly. The task must be understandable without any prior conversation context.",
        ),
    }),
    execute: async function* (
      { subAgent, task },
      options,
    ): AsyncGenerator<SubAgentActivity> {
      const { abortSignal } = options;
      const key = targetKey(subAgent);
      const delegate = byKey.get(key);

      if (!delegate) {
        const refused = refusals.get(key);
        throw new Error(
          refused
            ? `Sub-agent "${refused.name}" is unavailable this turn: ${refused.reason}. Do not retry it.` +
                (names.length
                  ? ` The sub-agents you can delegate to are: ${listTargets(names)}.`
                  : "")
            : `Unknown sub-agent "${subAgent}". The sub-agents you can delegate to are: ${listTargets(names)}.`,
        );
      }

      yield* delegate.run(task, {
        abortSignal,
        events: runEventScopeOf(options),
      });
    },
    toModelOutput: ({ output }) => {
      /* eslint-disable @typescript-eslint/no-unnecessary-condition -- a
         delegate that yields nothing leaves `output` undefined, though the SDK
         types it as present */
      const value = output?.text ?? "Task completed.";
      const note = output?.truncatedByTokenLimit
        ? SUB_AGENT_TRUNCATION_NOTE
        : output?.stoppedAtStepLimit
          ? SUB_AGENT_STEP_LIMIT_NOTE
          : undefined;
      /* eslint-enable @typescript-eslint/no-unnecessary-condition */
      return {
        type: "text" as const,
        value: note ? `${value}\n\n${note}`.trim() : value,
      };
    },
  });
};

export type DelegateTool = ReturnType<typeof createDelegateTool>;

export type SubAgentFailure = { id: string; name?: string; reason: string };

export type SubAgentCatalogueEntry = {
  name: string;
  description?: string | null;
};

export const COLLIDING_SUB_AGENT_NAME_REASON =
  "another sub-agent assigned to this agent has the same name, so neither can be delegated to unambiguously — rename one of them";

export type SubAgentPlan = {
  plan: Omit<RunPlan, "system" | "tools">;
  guardrails: string | null;
  fallback?: GenerationPlan;
};

export const createDelegateTools = async <
  T extends {
    id: string;
    name: string;
    description?: string | null;
    instructions?: string | null;
    toolSetIds: string[];
  },
>(
  subAgents: T[],
  resolvePlan: (subAgent: T) => Promise<SubAgentPlan>,
  loadToolsFn: (
    subAgentId: string,
    toolSetIds: string[],
  ) => Promise<LoadedSubAgentTools>,
  parentRun?: ParentRunContext,
  alreadyUnavailable: SubAgentFailure[] = [],
): Promise<{
  tools: Record<string, Tool>;
  catalogue: SubAgentCatalogueEntry[];
  failures: SubAgentFailure[];
}> => {
  const delegates: SubAgentDelegate[] = [];
  const failures: SubAgentFailure[] = [...alreadyUnavailable];

  const collisions = new Set<string>();
  const seen = new Set<string>();
  for (const subAgent of subAgents) {
    const key = targetKey(subAgent.name);
    if (seen.has(key)) collisions.add(key);
    seen.add(key);
  }

  for (const subAgent of subAgents) {
    if (collisions.has(targetKey(subAgent.name))) {
      logger.warn(
        { subAgentName: subAgent.name, subAgentId: subAgent.id },
        `Sub-agent name "${subAgent.name}" is not unique among this agent's sub-agents`,
      );
      failures.push({
        id: subAgent.id,
        name: subAgent.name,
        reason: COLLIDING_SUB_AGENT_NAME_REASON,
      });
      continue;
    }

    try {
      const { plan, guardrails, fallback } = await resolvePlan(subAgent);

      let toolsPromise: Promise<LoadedSubAgentTools> | undefined;
      const loadTools = () =>
        (toolsPromise ??= loadToolsFn(subAgent.id, subAgent.toolSetIds));

      delegates.push(
        createSubAgentDelegate({
          id: subAgent.id,
          name: subAgent.name,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
          description: subAgent.description || undefined,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
          instructions: subAgent.instructions || undefined,
          loadTools,
          plan,
          guardrails,
          parentRun,
          ...(fallback ? { fallback } : {}),
        }),
      );
    } catch (error) {
      logger.error(
        { error, subAgentName: subAgent.name, subAgentId: subAgent.id },
        `Failed to create sub-agent delegate for "${subAgent.name}"`,
      );
      failures.push({
        id: subAgent.id,
        name: subAgent.name,
        reason: describeSdkError(error),
      });
    }
  }

  const refusals = new Map<string, { name: string; reason: string }>();
  for (const failure of failures) {
    const refusal = {
      name: failure.name ?? failure.id,
      reason: failure.reason,
    };
    refusals.set(targetKey(failure.id), refusal);
    if (failure.name) refusals.set(targetKey(failure.name), refusal);
  }

  return {
    tools: delegates.length
      ? { [DELEGATE_TOOL_NAME]: createDelegateTool(delegates, refusals) }
      : {},
    catalogue: delegates.map(({ name, description }) => ({
      name,
      description,
    })),
    failures,
  };
};
