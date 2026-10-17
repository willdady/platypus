"use client";

import {
  BanIcon,
  BotIcon,
  BrainIcon,
  CheckCircleIcon,
  PenLineIcon,
  WrenchIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { RunEventStatus, RunEventType } from "@platypus/schemas";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * One line of agent activity, as a Sub-Agent's card in a Chat and a Trigger
 * run's timeline both draw it: what kind of thing happened, its name where it
 * has one, and how it stands. The two readers share the SHAPE — a delegate
 * reads the same way wherever it appears — and nothing else: the Chat card
 * streams its entries live, the timeline reads persisted Run events.
 *
 * `failed` is not a Run event type. It is the shape a Chat's Sub-Agent card
 * has always yielded for "the delegation itself failed", stored on every such
 * Chat message for ever, so it stays readable here without being written
 * anywhere new.
 */
export type ActivityRowEntry = {
  type: RunEventType | "failed";
  toolName?: string | null;
  status: RunEventStatus;
  error?: string;
  /** How many identical consecutive entries this row stands for. */
  count?: number;
};

/**
 * The colour each kind of Run event is drawn in, wherever activity is shown:
 * `text` for an icon, `bg` for a timeline bar.
 */
export const activityColor: Record<RunEventType, { text: string; bg: string }> =
  {
    "tool-call": { text: "text-blue-500", bg: "bg-blue-500" },
    reasoning: { text: "text-purple-500", bg: "bg-purple-500" },
    text: { text: "text-amber-500", bg: "bg-amber-500" },
    delegate: { text: "text-emerald-500", bg: "bg-emerald-500" },
  };

const config: Record<
  ActivityRowEntry["type"],
  {
    icon: LucideIcon;
    activeColor: string;
    label: (entry: ActivityRowEntry) => string;
  }
> = {
  "tool-call": {
    icon: WrenchIcon,
    activeColor: activityColor["tool-call"].text,
    label: (entry) => entry.toolName ?? "tool",
  },
  reasoning: {
    icon: BrainIcon,
    activeColor: activityColor.reasoning.text,
    label: () => "Thinking…",
  },
  text: {
    icon: PenLineIcon,
    activeColor: activityColor.text.text,
    label: () => "Generating response…",
  },
  delegate: {
    icon: BotIcon,
    activeColor: activityColor.delegate.text,
    label: (entry) => entry.toolName ?? "Sub-Agent",
  },
  failed: {
    icon: XCircleIcon,
    activeColor: "text-destructive",
    label: () => "Run failed",
  },
};

/** The words a row's label uses for an entry, exported so tests need not restate them. */
export function activityLabel(entry: ActivityRowEntry): string {
  return config[entry.type].label(entry);
}

function StatusMark({ status }: { status: RunEventStatus }) {
  switch (status) {
    case "running":
      return (
        <Badge
          variant="secondary"
          className="rounded-full text-2xs px-1.5 py-0"
        >
          running
        </Badge>
      );
    case "error":
      return (
        <XCircleIcon
          className="size-3.5 shrink-0 text-destructive"
          aria-label="Failed"
        />
      );
    case "cancelled":
      return (
        <BanIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-label="Cancelled"
        />
      );
    default:
      return (
        <CheckCircleIcon
          className="size-3.5 shrink-0 text-success"
          aria-label="Completed"
        />
      );
  }
}

export function ActivityRow({
  entry,
  trailing,
  className,
}: {
  entry: ActivityRowEntry;
  /** Anything to draw after the status mark — a duration, say. */
  trailing?: ReactNode;
  className?: string;
}) {
  const { icon: Icon, activeColor } = config[entry.type];
  const isRunning = entry.status === "running";

  return (
    <div className={cn("flex flex-col gap-0.5 py-1", className)}>
      <div className="flex items-center gap-2 text-sm">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            isRunning
              ? `${activeColor} animate-pulse`
              : entry.status === "error"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        />
        <span className="text-muted-foreground truncate">
          {activityLabel(entry)}
          {entry.count && entry.count > 1 && (
            <span className="ml-1 text-xs text-muted-foreground/70">
              &times;{entry.count}
            </span>
          )}
        </span>
        <StatusMark status={entry.status} />
        {trailing}
      </div>
      {entry.error && (
        <span className="ml-5.5 text-xs text-destructive truncate">
          {entry.error}
        </span>
      )}
    </div>
  );
}
