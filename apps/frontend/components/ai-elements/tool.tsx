"use client";

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FilePenIcon,
  FilePlusIcon,
  FileTextIcon,
  FingerprintIcon,
  FileDownIcon,
  FolderIcon,
  GlobeIcon,
  KanbanSquareIcon,
  MessageSquareIcon,
  SparklesIcon,
  TerminalIcon,
  ZapIcon,
  WrenchIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  createElement,
  isValidElement,
  useContext,
} from "react";
import { ToolDuration } from "../tool-duration";

export function humanizeToolType(type: string): string {
  const name = type.startsWith("tool-") ? type.slice(5) : type;
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .split(" ")
    .filter(Boolean);
  return words
    .map((w, i) =>
      i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase(),
    )
    .join(" ");
}

const toolToToolSet: Record<string, string> = {
  listBoards: "kanban",
  getBoardState: "kanban",
  getCard: "kanban",
  createCard: "kanban",
  updateCard: "kanban",
  moveCard: "kanban",
  copyCard: "kanban",
  deleteCard: "kanban",
  listComments: "kanban",
  createComment: "kanban",
  updateComment: "kanban",
  deleteComment: "kanban",
  // why: kept so Tool parts already stored in Chats still resolve their Tool set
  upsertCard: "kanban",
  upsertComment: "kanban",
  createBoard: "kanban-boards",
  updateBoard: "kanban-boards",
  deleteBoard: "kanban-boards",
  createColumn: "kanban-boards",
  updateColumn: "kanban-boards",
  deleteColumn: "kanban-boards",
  reorderColumns: "kanban-boards",
  upsertBoard: "kanban-boards",
  upsertColumn: "kanban-boards",
  listTriggers: "triggers",
  getTrigger: "triggers",
  createTrigger: "triggers",
  updateTrigger: "triggers",
  deleteTrigger: "triggers",
  upsertTrigger: "triggers",
  listToolSets: "agent-discovery",
  listModelProviders: "agent-discovery",
  listAgents: "agent-discovery",
  getAgent: "agent-discovery",
  listSkills: "skill-management",
  getSkill: "skill-management",
  upsertSkill: "skill-management",
  deleteSkill: "skill-management",
  createAgent: "agent-management",
  updateAgent: "agent-management",
  deleteAgent: "agent-management",
  getCurrentTime: "time",
  convertTimezone: "time",
  generateUuid: "identifiers",
  generateNanoId: "identifiers",
  convertTemperature: "math-conversions",
  convertDistance: "math-conversions",
  convertWeight: "math-conversions",
  convertVolume: "math-conversions",
  fetchUrl: "web-fetch",
  createNotification: "notifications",
  listNotifications: "notifications",
  updateNotification: "notifications",
  deleteNotification: "notifications",
  memorySearch: "memory",
  memoryGet: "memory",
  listChats: "chats",
  readTranscript: "chats",
  createArtifact: "artifacts",
  updateArtifact: "artifacts",
  readArtifact: "artifacts",
  listArtifacts: "artifacts",
  shellExec: "sandbox",
  fsRead: "sandbox",
  fsWrite: "sandbox",
  fsEdit: "sandbox",
  fsList: "sandbox",
  fsDownload: "sandbox",
  fsView: "sandbox",
};

// why: not a toolset — contributed per Provider, and shares web-fetch's globe
const toolIcons: Record<string, LucideIcon> = {
  web_search: GlobeIcon,
  read_url: GlobeIcon,
  // why: one delegate tool for every Sub-Agent, drawn like its activity rows
  delegate: BotIcon,
  shellExec: TerminalIcon,
  fsRead: FileIcon,
  fsWrite: FilePlusIcon,
  fsEdit: FilePenIcon,
  fsList: FolderIcon,
  fsDownload: FileDownIcon,
  fsView: EyeIcon,
};

const toolSetIcons: Record<string, LucideIcon> = {
  kanban: KanbanSquareIcon,
  "kanban-boards": KanbanSquareIcon,
  triggers: ZapIcon,
  "agent-discovery": BotIcon,
  "skill-management": SparklesIcon,
  "agent-management": BotIcon,
  time: ClockIcon,
  identifiers: FingerprintIcon,
  "math-conversions": ArrowRightLeftIcon,
  "web-fetch": GlobeIcon,
  notifications: BellIcon,
  memory: BrainIcon,
  chats: MessageSquareIcon,
  artifacts: FileTextIcon,
  sandbox: BoxIcon,
};

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

type ToolContextValue = { isOpen: boolean };

const ToolContext = createContext<ToolContextValue | null>(null);

function useTool() {
  const context = useContext(ToolContext);
  if (!context) {
    throw new Error("Tool components must be used within Tool");
  }
  return context;
}

export const toolRowClassName =
  "flex w-full min-w-0 items-center gap-2 text-left text-muted-foreground text-sm";

// why: size-6 matches the assistant avatar, so text lines up beside the chat
export const toolRowIconSlotClassName =
  "flex size-6 shrink-0 items-center justify-center";

export type ToolProps = ComponentProps<typeof Collapsible>;

export function Tool({
  className,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: ToolProps) {
  const [isOpen, setIsOpen] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });

  return (
    <ToolContext.Provider value={{ isOpen }}>
      <Collapsible
        className={cn("w-full min-w-0", className)}
        open={isOpen}
        onOpenChange={setIsOpen}
        {...props}
      >
        {children}
      </Collapsible>
    </ToolContext.Provider>
  );
}

export type ToolHeaderProps = {
  title?: string;
  label?: string;
  type: ToolUIPart["type"] | "dynamic-tool";
  state: ToolUIPart["state"];
  durationMs?: number;
  className?: string;
  // why: cleared only drops it from the next model call; the result is still here
  cleared?: boolean;
};

export function ToolStatus({ state }: { state: ToolUIPart["state"] }) {
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
    "input-streaming": <CircleIcon className="size-3.5" />,
    "input-available": <ClockIcon className="size-3.5 animate-pulse" />,
    "output-available": <CheckCircleIcon className="size-3.5 text-success" />,
    "output-error": <XCircleIcon className="size-3.5 text-destructive" />,
    "approval-requested": <ClockIcon className="size-3.5" />,
    "approval-responded": <CheckCircleIcon className="size-3.5" />,
    "output-denied": <XCircleIcon className="size-3.5 text-destructive" />,
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs">
      {icons[state]}
      {labels[state]}
    </span>
  );
}

export function ClearedResultBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          className="gap-1 rounded-full text-xs text-muted-foreground"
          variant="outline"
        >
          <EyeOffIcon className="size-3" />
          Not sent to model
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        This was left out of the last model call to free up space in the context
        window. It is still here — expand to read it.
      </TooltipContent>
    </Tooltip>
  );
}

export function ToolHeader({
  className,
  title,
  label,
  type,
  state,
  durationMs,
  cleared,
  ...props
}: ToolHeaderProps) {
  const { isOpen } = useTool();
  const name = title ?? humanizeToolType(type);

  // why: createElement, not JSX, so a dynamic icon isn't read as made in render
  return (
    <CollapsibleTrigger
      className={cn(
        toolRowClassName,
        "transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    >
      <span className={toolRowIconSlotClassName}>
        {createElement(getToolIcon(type), { className: "size-4" })}
      </span>
      <span
        className="min-w-0 truncate select-text"
        title={label ? `${name} — ${label}` : name}
      >
        {name}
        {label && <span> &mdash; {label}</span>}
      </span>
      <ToolDuration durationMs={durationMs} />
      {cleared && state === "output-available" && <ClearedResultBadge />}
      <ToolStatus state={state} />
      <ChevronDownIcon
        className={cn(
          "size-4 shrink-0 transition-transform",
          isOpen ? "rotate-180" : "rotate-0",
        )}
      />
    </CollapsibleTrigger>
  );
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export function ToolContent({ className, ...props }: ToolContentProps) {
  return (
    <CollapsibleContent
      className={cn(
        // why: pl-8 lines the body up with the chat text; sections gap, never rules
        "mt-3 flex flex-col gap-4 pl-8 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className,
      )}
      {...props}
    />
  );
}

const toolPanelClassName = "overflow-auto p-4 text-xs text-foreground";

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export function ToolInput({ className, input, ...props }: ToolInputProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Parameters
      </h4>
      <pre className={cn(toolPanelClassName, "rounded-md bg-muted/50")}>
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
};

export function ToolOutput({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) {
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <pre className={toolPanelClassName}>
        {JSON.stringify(output, null, 2)}
      </pre>
    );
  } else if (typeof output === "string") {
    Output = <pre className={toolPanelClassName}>{output}</pre>;
  }

  return (
    <div className={cn("flex flex-col gap-2", className)} {...props}>
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
}
