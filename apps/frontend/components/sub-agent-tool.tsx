"use client";

import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  BotIcon,
  XCircleIcon,
  WrenchIcon,
  BrainIcon,
  PenLineIcon,
} from "lucide-react";
import type { ToolUIPart } from "ai";
import { Badge } from "@/components/ui/badge";
import { TurnNotice } from "./turn-notice";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "./ai-elements/message";
import { Shimmer } from "./ai-elements/shimmer";
import { ToolDuration } from "./tool-duration";
import { toolCallDurationMs } from "@/lib/tool-duration";
import { useMemo, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

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

const getStatusBadge = (status: ToolUIPart["state"]) => {
  const labels: Record<ToolUIPart["state"], string> = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "output-available": "Completed",
    "output-error": "Error",
    "approval-requested": "Approval Requested",
    "approval-responded": "Approval Responded",
    "output-denied": "Denied",
  };

  const icons: Record<ToolUIPart["state"], ReactNode> = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-error": <XCircleIcon className="size-4 text-red-600" />,
    "approval-requested": <ClockIcon className="size-4" />,
    "approval-responded": <CheckCircleIcon className="size-4" />,
    "output-denied": <XCircleIcon className="size-4 text-red-600" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {labels[status]}
    </Badge>
  );
};

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

type CompactEntry = SubAgentActivityEntry & { count?: number };

/**
 * Folds consecutive completed entries with the same type and toolName into a
 * single row with a count (e.g. "upsertCard ×3"). Running or error entries
 * are never folded — a trailing running entry that matches the preceding
 * completed streak stays on its own line.
 */
const compactEntries = (entries: SubAgentActivityEntry[]): CompactEntry[] => {
  const result: CompactEntry[] = [];

  for (const entry of entries) {
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

const entryConfig: Record<
  SubAgentActivityEntry["type"],
  { icon: LucideIcon; activeColor: string; label: (e: CompactEntry) => string }
> = {
  "tool-call": {
    icon: WrenchIcon,
    activeColor: "text-blue-500",
    label: (e) => e.toolName ?? "tool",
  },
  thinking: {
    icon: BrainIcon,
    activeColor: "text-purple-500",
    label: () => "Thinking\u2026",
  },
  generating: {
    icon: PenLineIcon,
    activeColor: "text-amber-500",
    label: () => "Generating response\u2026",
  },
  failed: {
    icon: XCircleIcon,
    activeColor: "text-red-500",
    label: () => "Run failed",
  },
};

const ActivityEntry = ({ entry }: { entry: CompactEntry }) => {
  const { icon: Icon, activeColor, label } = entryConfig[entry.type];
  const isRunning = entry.status === "running";

  return (
    <div className="flex flex-col gap-0.5 py-1">
      <div className="flex items-center gap-2 text-sm">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            isRunning
              ? `${activeColor} animate-pulse`
              : entry.status === "error"
                ? "text-red-500"
                : "text-muted-foreground",
          )}
        />
        <span className="text-muted-foreground">
          {label(entry)}
          {entry.count && entry.count > 1 && (
            <span className="ml-1 text-xs text-muted-foreground/70">
              &times;{entry.count}
            </span>
          )}
        </span>
        {isRunning ? (
          <Badge
            variant="secondary"
            className="rounded-full text-[10px] px-1.5 py-0"
          >
            running
          </Badge>
        ) : entry.status === "error" ? (
          <XCircleIcon className="size-3.5 shrink-0 text-red-600" />
        ) : (
          <CheckCircleIcon className="size-3.5 shrink-0 text-green-600" />
        )}
      </div>
      {entry.error && (
        <span className="ml-5.5 text-xs text-red-600 truncate">
          {entry.error}
        </span>
      )}
    </div>
  );
};

/**
 * The delegate's answer. One component for both call sites — with and without
 * an activity log — so a marker can never be shown on one and missed on the
 * other. `notice` is the resolved wording for whichever limit stopped the
 * delegation, absent when it finished on its own.
 */
const ResponseBlock = ({ text, notice }: { text: string; notice?: string }) => (
  <div className="space-y-2 border-t p-4">
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

  return (
    <Collapsible className="not-prose mb-4 w-full rounded-md border group/subagent">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">{subAgentName}</span>
          <ToolDuration
            durationMs={toolCallDurationMs(
              toolPart.toolMetadata,
              messageMetadata,
              toolPart.toolCallId,
            )}
          />
          {getStatusBadge(effectiveState)}
        </div>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]/subagent:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        )}
      >
        {/* Task input */}
        <div className="space-y-2 border-t p-4">
          <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Task
          </h4>
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            {input?.task || "No task description"}
          </div>
        </div>

        {/* Activity log, error, working indicator, or response */}
        {errorText ? (
          <div className="space-y-2 border-t p-4">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Error
            </h4>
            <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
              {errorText}
            </div>
          </div>
        ) : activity && activity.entries.length > 0 ? (
          <>
            <div className="space-y-1 border-t px-4 py-3">
              <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide mb-1">
                Activity
              </h4>
              {compacted.map((entry, i) => (
                <ActivityEntry key={i} entry={entry} />
              ))}
            </div>
            {responseText ? (
              <ResponseBlock text={responseText} notice={cutShortNotice} />
            ) : null}
          </>
        ) : !isComplete ? (
          <div className="border-t p-4">
            <Shimmer className="text-sm">Working...</Shimmer>
          </div>
        ) : responseText ? (
          <ResponseBlock text={responseText} notice={cutShortNotice} />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
};
