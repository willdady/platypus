"use client";

import type { ToolUIPart } from "ai";
import { ActivityRow, type ActivityRowEntry } from "./activity-row";
import { TurnNotice } from "./turn-notice";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "./ai-elements/message";
import { Shimmer } from "./ai-elements/shimmer";
import { Tool, ToolContent, ToolHeader } from "./ai-elements/tool";
import { toolCallDurationMs } from "@/lib/tool-duration";
import { useMemo } from "react";

type SubAgentActivityEntry = {
  type: "tool-call" | "thinking" | "generating" | "failed";
  toolName?: string;
  status: "running" | "completed" | "error";
  error?: string;
};

type SubAgentActivity = {
  entries: SubAgentActivityEntry[];
  text?: string;
  truncatedByTokenLimit?: true;
  stoppedAtStepLimit?: true;
};

/**
 * What the person reading a delegated run is told when the Sub-Agent stopped at
 * its model's output ceiling rather than because it had finished. The Chat
 * counterpart of the marker a cut-short reply carries, one level down: the card
 * shows the delegate's answer verbatim, so an unmarked fragment reads as a
 * finished finding. A constant so tests assert the wording without restating it.
 */
export const SUB_AGENT_CUT_SHORT_NOTICE =
  "Sub-Agent response cut short at the model's output limit.";

/**
 * The same thing for the other limit: the Sub-Agent's tool-calling loop ran out
 * of steps while it was still working, so what came back is as far as it got —
 * which may be a tool result and no answer at all.
 */
export const SUB_AGENT_STEP_LIMIT_NOTICE =
  "Sub-Agent response cut short at the step limit.";

const isSubAgentActivity = (output: unknown): output is SubAgentActivity =>
  typeof output === "object" &&
  output !== null &&
  "entries" in output &&
  Array.isArray((output as SubAgentActivity).entries);

/**
 * Extracts the sub-agent name from a pre-dispatcher tool name.
 * e.g., "delegateToDadJokeBot" -> "Dad Joke Bot"
 *
 * Only reachable for parts stored before delegation collapsed into a single
 * `delegate` tool, which is for ever: stored Chat messages carry the tool name
 * that was current when they were written and are never rewritten.
 */
const extractSubAgentName = (toolName: string): string => {
  const prefix = "delegateTo";
  if (toolName.startsWith(prefix)) {
    const namePart = toolName.slice(prefix.length);
    return namePart.replace(/([A-Z])/g, " $1").trim();
  }
  return toolName;
};

/**
 * Whose name to put on the card.
 *
 * A new-shape part names its target in the tool's own input, because one tool
 * serves every sub-agent — there is nothing in `tool-delegate` to un-mangle.
 * The name arrives with the streamed input, so the fallback covers only the
 * sliver of a turn before the model has finished writing the call.
 */
const subAgentNameOf = (toolPart: ToolUIPart): string => {
  const toolName = toolPart.type.replace("tool-", "");
  if (toolName !== "delegate") return extractSubAgentName(toolName);
  const target = (toolPart.input as { subAgent?: string } | undefined)
    ?.subAgent;
  return target?.trim() || "Sub-Agent";
};

/**
 * A streamed activity entry in the shape the shared row draws. The yielded
 * vocabulary predates Run events and is stored on every Chat that ever
 * delegated, so it is translated here rather than rewritten: `thinking` is a
 * reasoning stretch and `generating` a text stretch; `failed` — the delegation
 * itself failing — the row still knows how to draw.
 */
const toRowEntry = (entry: SubAgentActivityEntry): ActivityRowEntry => ({
  type:
    entry.type === "thinking"
      ? "reasoning"
      : entry.type === "generating"
        ? "text"
        : entry.type,
  toolName: entry.toolName,
  status: entry.status,
  error: entry.error,
});

/**
 * Folds consecutive completed entries with the same type and toolName into a
 * single row with a count (e.g. "upsertCard ×3"). Running or error entries
 * are never folded — a trailing running entry that matches the preceding
 * completed streak stays on its own line.
 */
const compactEntries = (
  entries: SubAgentActivityEntry[],
): ActivityRowEntry[] => {
  const result: ActivityRowEntry[] = [];

  for (const raw of entries) {
    const entry = toRowEntry(raw);
    const prev = result[result.length - 1];
    if (
      prev &&
      prev.status === "completed" &&
      entry.status === "completed" &&
      prev.type === entry.type &&
      prev.toolName === entry.toolName
    ) {
      prev.count = (prev.count ?? 1) + 1;
    } else {
      result.push({ ...entry });
    }
  }

  return result;
};

/**
 * The delegate's answer. One component for both call sites — with and without
 * an activity log — so a marker can never be shown on one and missed on the
 * other. `notice` is the resolved wording for whichever limit stopped the
 * delegation, absent when it finished on its own.
 */
const ResponseBlock = ({ text, notice }: { text: string; notice?: string }) => (
  <div className="space-y-2">
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Response
    </h4>
    <Message from="assistant">
      <MessageContent className="max-w-full">
        <MessageResponse>{text}</MessageResponse>
      </MessageContent>
    </Message>
    {notice && <TurnNotice className="mt-2">{notice}</TurnNotice>}
  </div>
);

interface SubAgentToolProps {
  toolPart: ToolUIPart;
  /**
   * The metadata of the message this invocation sits on, which is where a
   * duration arrives from mid-turn. Passed in rather than read here: resolving
   * it needs both carriers, and the composing message already holds them.
   */
  messageMetadata?: unknown;
}

/**
 * Renders a sub-agent tool invocation. Shows a real-time activity log while the
 * sub-agent runs, then the plain-text result when complete.
 */
export const SubAgentTool = ({
  toolPart,
  messageMetadata,
}: SubAgentToolProps) => {
  const input = toolPart.input as { task?: string };
  const output = toolPart.output as SubAgentActivity | string | null;
  const errorText = toolPart.errorText;
  const subAgentName = subAgentNameOf(toolPart);
  const isRunning =
    toolPart.state === "input-streaming" ||
    toolPart.state === "input-available";

  const activity = isSubAgentActivity(output) ? output : null;
  const legacyText = typeof output === "string" ? output : null;
  const responseText = activity?.text ?? legacyText;
  // Which limit ended the delegation, if either did. At most one applies: a
  // terminal finish names the output ceiling or a loop the model wanted to
  // continue, never both.
  const cutShortNotice = activity?.truncatedByTokenLimit
    ? SUB_AGENT_CUT_SHORT_NOTICE
    : activity?.stoppedAtStepLimit
      ? SUB_AGENT_STEP_LIMIT_NOTICE
      : undefined;
  const compacted = useMemo(
    () => (activity ? compactEntries(activity.entries) : []),
    [activity],
  );

  // The SDK sets toolPart.state to "output-available" on preliminary (intermediate)
  // generator yields, so we can't rely on it alone. For activity-based outputs,
  // the tool is truly complete only when the final text is present.
  const isComplete =
    errorText != null ||
    (activity ? activity.text != null : !isRunning && output != null);

  const effectiveState: ToolUIPart["state"] = errorText
    ? "output-error"
    : isComplete
      ? "output-available"
      : isRunning || activity
        ? "input-available"
        : toolPart.state;

  // The shared shell draws the row; `type` picks the Sub-Agent icon, and
  // `title` names the delegate rather than the tool. Its open state is the
  // shell's own, so the nested transcript below can hold its own disclosures
  // without any of them turning this chevron.
  return (
    <Tool>
      <ToolHeader
        type="tool-delegate"
        title={subAgentName}
        state={effectiveState}
        durationMs={toolCallDurationMs(
          toolPart.toolMetadata,
          messageMetadata,
          toolPart.toolCallId,
        )}
      />

      <ToolContent>
        {/* Task input */}
        <div className="space-y-2">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Task
          </h4>
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            {input?.task || "No task description"}
          </div>
        </div>

        {/* Activity log, error, working indicator, or response */}
        {errorText ? (
          <div className="space-y-2">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Error
            </h4>
            <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
              {errorText}
            </div>
          </div>
        ) : activity && activity.entries.length > 0 ? (
          <>
            <div className="space-y-1">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide mb-1">
                Activity
              </h4>
              {compacted.map((entry, i) => (
                <ActivityRow key={i} entry={entry} />
              ))}
            </div>
            {responseText ? (
              <ResponseBlock text={responseText} notice={cutShortNotice} />
            ) : null}
          </>
        ) : !isComplete ? (
          <Shimmer className="text-sm">Working...</Shimmer>
        ) : responseText ? (
          <ResponseBlock text={responseText} notice={cutShortNotice} />
        ) : null}
      </ToolContent>
    </Tool>
  );
};
