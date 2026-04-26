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
import { useMemo, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type SubAgentActivityEntry = {
  type: "tool-call" | "thinking" | "generating";
  toolName?: string;
  status: "running" | "completed" | "error";
  error?: string;
};

type SubAgentActivity = {
  entries: SubAgentActivityEntry[];
  text?: string;
};

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
 * Extracts the sub-agent name from the tool name.
 * e.g., "delegateToDadJokeBot" -> "Dad Joke Bot"
 */
const extractSubAgentName = (toolName: string): string => {
  const prefix = "delegateTo";
  if (toolName.startsWith(prefix)) {
    const namePart = toolName.slice(prefix.length);
    return namePart.replace(/([A-Z])/g, " $1").trim();
  }
  return toolName;
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

interface SubAgentToolProps {
  toolPart: ToolUIPart;
}

/**
 * Renders a sub-agent tool invocation. Shows a real-time activity log while the
 * sub-agent runs, then the plain-text result when complete.
 */
export const SubAgentTool = ({ toolPart }: SubAgentToolProps) => {
  const input = toolPart.input as { task?: string };
  const output = toolPart.output as SubAgentActivity | string | null;
  const errorText = toolPart.errorText;
  const subAgentName = extractSubAgentName(toolPart.type.replace("tool-", ""));
  const isRunning =
    toolPart.state === "input-streaming" ||
    toolPart.state === "input-available";

  const activity = isSubAgentActivity(output) ? output : null;
  const legacyText = typeof output === "string" ? output : null;
  const responseText = activity?.text ?? legacyText;
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
              <div className="space-y-2 border-t p-4">
                <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                  Response
                </h4>
                <Message from="assistant">
                  <MessageContent className="max-w-full">
                    <MessageResponse>{responseText}</MessageResponse>
                  </MessageContent>
                </Message>
              </div>
            ) : null}
          </>
        ) : !isComplete ? (
          <div className="border-t p-4">
            <Shimmer className="text-sm">Working...</Shimmer>
          </div>
        ) : responseText ? (
          <div className="space-y-2 border-t p-4">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Response
            </h4>
            <Message from="assistant">
              <MessageContent className="max-w-full">
                <MessageResponse>{responseText}</MessageResponse>
              </MessageContent>
            </Message>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
};
