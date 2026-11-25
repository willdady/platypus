"use client";

import type { ToolUIPart } from "ai";
import type {
  SubAgentActivity,
  SubAgentActivityEntry,
} from "@platypus/schemas";
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
import { toolErrorText } from "@/lib/message-parts";
import { useMemo } from "react";

export const SUB_AGENT_CUT_SHORT_NOTICE =
  "Sub-Agent response cut short at the model's output limit.";

export const SUB_AGENT_STEP_LIMIT_NOTICE =
  "Sub-Agent response cut short at the step limit. Raise the Sub-Agent's Max steps to let it finish.";

function isSubAgentActivity(output: unknown): output is SubAgentActivity {
  return (
    typeof output === "object" &&
    output !== null &&
    "entries" in output &&
    Array.isArray((output as SubAgentActivity).entries)
  );
}

function extractSubAgentName(toolName: string): string {
  const prefix = "delegateTo";
  if (toolName.startsWith(prefix)) {
    const namePart = toolName.slice(prefix.length);
    return namePart.replace(/([A-Z])/g, " $1").trim();
  }
  return toolName;
}

function subAgentNameOf(toolPart: ToolUIPart): string {
  const toolName = toolPart.type.replace("tool-", "");
  if (toolName !== "delegate") return extractSubAgentName(toolName);
  const target = (toolPart.input as { subAgent?: string } | undefined)
    ?.subAgent;
  return target?.trim() || "Sub-Agent";
}

// why: stored Chats still carry the old vocabulary, so it is translated, not rewritten
function toRowEntry(entry: SubAgentActivityEntry): ActivityRowEntry {
  return {
    type:
      entry.type === "thinking"
        ? "reasoning"
        : entry.type === "generating"
          ? "text"
          : entry.type,
    toolName: entry.toolName,
    status: entry.status,
    error: entry.error,
  };
}

function compactEntries(entries: SubAgentActivityEntry[]): ActivityRowEntry[] {
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
}

function ResponseBlock({ text, notice }: { text: string; notice?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Response
      </h4>
      <Message from="assistant">
        <MessageContent className="max-w-full">
          <MessageResponse>{text}</MessageResponse>
        </MessageContent>
      </Message>
      {notice && <TurnNotice>{notice}</TurnNotice>}
    </div>
  );
}

type SubAgentToolProps = {
  toolPart: ToolUIPart;
  // why: resolving a duration needs both carriers, and the message already has them
  messageMetadata?: unknown;
};

export function SubAgentTool({ toolPart, messageMetadata }: SubAgentToolProps) {
  const input = toolPart.input as { task?: string };
  const output = toolPart.output as SubAgentActivity | string | null;
  const denied = toolPart.state === "output-denied";
  const errorText = toolErrorText(toolPart);
  const subAgentName = subAgentNameOf(toolPart);
  const isRunning =
    toolPart.state === "input-streaming" ||
    toolPart.state === "input-available";

  const activity = isSubAgentActivity(output) ? output : null;
  const legacyText = typeof output === "string" ? output : null;
  const responseText = activity?.text ?? legacyText;
  // why: a finish names either the output ceiling or a step limit, never both
  const cutShortNotice = activity?.truncatedByTokenLimit
    ? SUB_AGENT_CUT_SHORT_NOTICE
    : activity?.stoppedAtStepLimit
      ? SUB_AGENT_STEP_LIMIT_NOTICE
      : undefined;
  const compacted = useMemo(
    () => (activity ? compactEntries(activity.entries) : []),
    [activity],
  );

  const isComplete =
    errorText != null ||
    (activity ? activity.text != null : !isRunning && output != null);

  const effectiveState: ToolUIPart["state"] = denied
    ? "output-denied"
    : errorText
      ? "output-error"
      : isComplete
        ? "output-available"
        : isRunning || activity
          ? "input-available"
          : toolPart.state;

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
        <div className="flex flex-col gap-2">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Task
          </h4>
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            {input?.task || "No task description"}
          </div>
        </div>

        {errorText ? (
          <div className="flex flex-col gap-2">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Error
            </h4>
            <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
              {errorText}
            </div>
          </div>
        ) : activity && activity.entries.length > 0 ? (
          <>
            <div className="flex flex-col gap-1">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
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
}
