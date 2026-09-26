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
  EyeOffIcon,
  FileIcon,
  FilePenIcon,
  FilePlusIcon,
  FingerprintIcon,
  FileDownIcon,
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
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  createElement,
  isValidElement,
  useContext,
} from "react";
import { ToolDuration } from "../tool-duration";

/**
 * Converts a camelCase tool name (extracted from a `tool-*` type string)
 * into a human-friendly label.
 * e.g. "tool-getBoardState" → "Get board state"
 *
 * Underscores count as word boundaries too: snake_case reaches here from
 * provider-native search (`web_search`), the Web-search backend tools (ADR-0014),
 * and most MCP servers, all of which read as "Web_search" otherwise.
 */
export function humanizeToolType(type: string): string {
  // Strip the "tool-" prefix
  const name = type.startsWith("tool-") ? type.slice(5) : type;
  // Split on camelCase boundaries and underscores
  const words = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .split(" ")
    .filter(Boolean);
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
  // identifiers
  generateUuid: "identifiers",
  generateNanoId: "identifiers",
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
  fsDownload: "sandbox",
};

// Per-tool icon overrides, used when a single toolset has visually distinct
// tools (e.g. the sandbox toolset's shell vs filesystem tools). Sparse —
// tools without an entry fall back to their toolset icon.
const toolIcons: Record<string, LucideIcon> = {
  // Web-search backend tools (ADR-0014). Not a toolset — they are contributed
  // per Provider through `searchSource` — so they are named here rather than
  // in `toolToToolSet`, and they share `web-fetch`'s globe: same job to a
  // reader.
  web_search: GlobeIcon,
  read_url: GlobeIcon,
  // Delegation to a Sub-Agent: one tool serving every delegate, drawn with
  // the same bot the Sub-Agent's own activity rows use.
  delegate: BotIcon,
  shellExec: TerminalIcon,
  fsRead: FileIcon,
  fsWrite: FilePlusIcon,
  fsEdit: FilePenIcon,
  fsList: FolderIcon,
  fsDownload: FileDownIcon,
};

/** One icon per toolset, matching the workspace home page. */
const toolSetIcons: Record<string, LucideIcon> = {
  kanban: KanbanSquareIcon,
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

type ToolContextValue = { isOpen: boolean };

const ToolContext = createContext<ToolContextValue | null>(null);

const useTool = () => {
  const context = useContext(ToolContext);
  if (!context) {
    throw new Error("Tool components must be used within Tool");
  }
  return context;
};

/**
 * The row every tool call — collapsible or not — is drawn with, shared with
 * `LoadSkillTool` so its one-shot status line sits flush with its neighbours.
 */
export const toolRowClassName =
  "flex w-full min-w-0 items-center gap-2 text-left text-muted-foreground text-sm";

/**
 * The slot a row's icon sits in: the same width as the assistant avatar
 * (`size-6`), so the text after it lines up with the chat text beside the
 * avatar, whichever of the two a reader is looking at.
 */
export const toolRowIconSlotClassName =
  "flex size-6 shrink-0 items-center justify-center";

export type ToolProps = ComponentProps<typeof Collapsible>;

/**
 * The Chat's tool disclosure shell (issue #834): the same borderless, muted
 * row Thinking draws, holding one tool call. Unlike `Reasoning` it never opens
 * or closes itself — a tool call is an execution record, so the reader's click
 * is the only thing that expands it — and it keeps its own open state so a
 * chevron answers to its row alone, however deep a Sub-Agent nests them.
 */
export const Tool = ({
  className,
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: ToolProps) => {
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
};

export type ToolHeaderProps = {
  title?: string;
  /** Optional human-readable label shown after the tool name (e.g. card title, agent name). */
  label?: string;
  /** The part's `type`: `tool-<name>`, or `dynamic-tool` for an MCP call. */
  type: ToolUIPart["type"] | "dynamic-tool";
  state: ToolUIPart["state"];
  /** Recorded execution time, once the run has been persisted. */
  durationMs?: number;
  className?: string;
  /**
   * Tool-result clearing (ADR-0018 Notes, issue #524) would leave this
   * result out of the next model call. The full result stays expandable
   * below — this only says the model no longer has it.
   */
  cleared?: boolean;
};

/**
 * How a tool call stands, in the words the Chat has always used for it. The
 * one copy of the state → wording table; every tool renderer draws this.
 */
export const ToolStatus = ({ state }: { state: ToolUIPart["state"] }) => {
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
    "output-available": <CheckCircleIcon className="size-3.5 text-green-600" />,
    "output-error": <XCircleIcon className="size-3.5 text-red-600" />,
    "approval-requested": <ClockIcon className="size-3.5" />,
    "approval-responded": <CheckCircleIcon className="size-3.5" />,
    "output-denied": <XCircleIcon className="size-3.5 text-red-600" />,
  };

  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs">
      {icons[state]}
      {labels[state]}
    </span>
  );
};

/**
 * Shown on a tool part whose result Tool-result clearing (ADR-0018 Notes,
 * issue #524) has left out of the next model call. The full result is still
 * expandable below this header — the badge says only that the model no
 * longer has it, never that it's gone.
 */
export const ClearedResultBadge = () => (
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
      This result was left out of the last model call to free up space in the
      context window. It is still here — expand to read it.
    </TooltipContent>
  </Tooltip>
);

export const ToolHeader = ({
  className,
  title,
  label,
  type,
  state,
  durationMs,
  cleared,
  ...props
}: ToolHeaderProps) => {
  const { isOpen } = useTool();
  const name = title ?? humanizeToolType(type);

  // getToolIcon returns a stable module-level Lucide icon; render via
  // createElement so the dynamic selection isn't flagged as a component
  // created during render.
  return (
    <CollapsibleTrigger
      className={cn(
        toolRowClassName,
        "cursor-pointer transition-colors hover:text-foreground",
        className,
      )}
      {...props}
    >
      <span className={toolRowIconSlotClassName}>
        {createElement(getToolIcon(type), { className: "size-4" })}
      </span>
      {/* `min-w-0` + `truncate` lets a long MCP name give way instead of
      pushing the row wide (issue #691); the full name rides on `title`. No
      `flex-1`: the duration, status and chevron follow the name rather than
      sitting at the row's far edge. */}
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
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      // Indented past the icon slot to the chat text's left edge, the way
      // Thinking's body sits. Sections stack with a gap rather than rules
      // between them.
      "mt-3 space-y-4 pl-8 text-sm",
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

/**
 * How a tool's Parameters and Result panels are drawn: preformatted text that
 * scrolls on its own axis, so a long unbroken value — a URL, a base64 blob —
 * is reachable rather than clipped (issue #922).
 *
 * `text-foreground` is on the panel rather than on either section, so the two
 * read as one pair. `ToolContent` mutes everything under it — that is right
 * for the section headings and wrong for the data, and the Result section
 * used to be the only one that said so.
 */
const toolPanelClassName = "overflow-auto p-4 text-xs text-foreground";

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <pre className={cn(toolPanelClassName, "rounded-md bg-muted/50")}>
      {JSON.stringify(input, null, 2)}
    </pre>
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
      <pre className={toolPanelClassName}>
        {JSON.stringify(output, null, 2)}
      </pre>
    );
  } else if (typeof output === "string") {
    Output = <pre className={toolPanelClassName}>{output}</pre>;
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
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
