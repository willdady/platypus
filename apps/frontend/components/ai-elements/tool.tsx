"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ToolUIPart } from "ai";
import {
  ArrowRightLeftIcon,
  BellIcon,
  BotIcon,
  BoxIcon,
  BrainIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  FileIcon,
  FilePenIcon,
  FilePlusIcon,
  FolderIcon,
  GlobeIcon,
  KanbanSquareIcon,
  LayoutDashboardIcon,
  SparklesIcon,
  TerminalIcon,
  ZapIcon,
  WrenchIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { CodeBlock } from "./code-block";

/**
 * Converts a camelCase tool name (extracted from a `tool-*` type string)
 * into a human-friendly label.
 * e.g. "tool-getBoardState" → "Get board state"
 */
export function humanizeToolType(type: string): string {
  // Strip the "tool-" prefix
  const name = type.startsWith("tool-") ? type.slice(5) : type;
  // Split on camelCase boundaries
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2").split(" ");
  // Capitalise the first word, lowercase the rest
  return words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase(),
    )
    .join(" ");
}

/** Maps each tool name to its owning toolset. */
const toolToToolSet: Record<string, string> = {
  // kanban
  listBoards: "kanban",
  getBoardState: "kanban",
  getCard: "kanban",
  upsertCard: "kanban",
  moveCard: "kanban",
  copyCard: "kanban",
  deleteCard: "kanban",
  listComments: "kanban",
  upsertComment: "kanban",
  deleteComment: "kanban",
  // triggers
  listTriggers: "triggers",
  getTrigger: "triggers",
  upsertTrigger: "triggers",
  deleteTrigger: "triggers",
  // agent-discovery
  listToolSets: "agent-discovery",
  listModelProviders: "agent-discovery",
  listAgents: "agent-discovery",
  getAgent: "agent-discovery",
  // skill-management
  listSkills: "skill-management",
  getSkill: "skill-management",
  upsertSkill: "skill-management",
  deleteSkill: "skill-management",
  // agent-management
  createAgent: "agent-management",
  updateAgent: "agent-management",
  deleteAgent: "agent-management",
  // time
  getCurrentTime: "time",
  convertTimezone: "time",
  // math-conversions
  convertTemperature: "math-conversions",
  convertDistance: "math-conversions",
  convertWeight: "math-conversions",
  convertVolume: "math-conversions",
  // web-fetch
  fetchUrl: "web-fetch",
  // notifications
  createNotification: "notifications",
  listNotifications: "notifications",
  updateNotification: "notifications",
  deleteNotification: "notifications",
  // memory
  memorySearch: "memory",
  memoryGet: "memory",
  // dashboards
  listDashboards: "dashboards",
  listWidgets: "dashboards",
  getWidget: "dashboards",
  updateWidgetData: "dashboards",
  // sandbox
  shellExec: "sandbox",
  fsRead: "sandbox",
  fsWrite: "sandbox",
  fsEdit: "sandbox",
  fsList: "sandbox",
};

// Per-tool icon overrides, used when a single toolset has visually distinct
// tools (e.g. the sandbox toolset's shell vs filesystem tools). Sparse —
// tools without an entry fall back to their toolset icon.
const toolIcons: Record<string, LucideIcon> = {
  shellExec: TerminalIcon,
  fsRead: FileIcon,
  fsWrite: FilePlusIcon,
  fsEdit: FilePenIcon,
  fsList: FolderIcon,
};

/** One icon per toolset, matching the workspace home page. */
const toolSetIcons: Record<string, LucideIcon> = {
  kanban: KanbanSquareIcon,
  triggers: ZapIcon,
  "agent-discovery": BotIcon,
  "skill-management": SparklesIcon,
  "agent-management": BotIcon,
  time: ClockIcon,
  "math-conversions": ArrowRightLeftIcon,
  "web-fetch": GlobeIcon,
  notifications: BellIcon,
  memory: BrainIcon,
  dashboards: LayoutDashboardIcon,
  sandbox: BoxIcon,
};

/** Returns an appropriate icon component for a given tool type string. */
export function getToolIcon(type: string): LucideIcon {
  const name = type.startsWith("tool-") ? type.slice(5) : type;
  if (toolIcons[name]) {
    return toolIcons[name];
  }
  const toolSet = toolToToolSet[name];
  if (toolSet) {
    return toolSetIcons[toolSet] ?? WrenchIcon;
  }
  return WrenchIcon;
}

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("not-prose mb-4 w-full rounded-md border group", className)}
    {...props}
  />
);

export type ToolHeaderProps = {
  title?: string;
  /** Optional human-readable label shown after the tool name (e.g. card title, agent name). */
  label?: string;
  type: ToolUIPart["type"];
  state: ToolUIPart["state"];
  className?: string;
};

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

export const ToolHeader = ({
  className,
  title,
  label,
  type,
  state,
  ...props
}: ToolHeaderProps) => {
  const Icon = getToolIcon(type);
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="font-medium text-sm truncate select-text">
          {title ?? humanizeToolType(type)}
          {label && (
            <span className="font-normal text-muted-foreground">
              {" "}
              &mdash; {label}
            </span>
          )}
        </span>
        {getStatusBadge(state)}
      </div>
      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden p-4", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    );
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2 p-4", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md text-xs [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground",
        )}
      >
        {errorText && <div>{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
