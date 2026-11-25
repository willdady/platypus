"use client";

import {
  BanIcon,
  BotIcon,
  BracesIcon,
  BrainIcon,
  CheckCircleIcon,
  PenLineIcon,
  RefreshCwIcon,
  WrenchIcon,
  XCircleIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  ModelSwitch,
  RunEventStatus,
  RunEventType,
} from "@platypus/schemas";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type ActivityRowEntry = {
  // why: "failed" is a stored Chat-card shape, not a Run event type, and must stay readable
  type: RunEventType | "failed";
  toolName?: string | null;
  status: RunEventStatus;
  error?: string;
  modelSwitch?: ModelSwitch | null;
  count?: number;
};

export const activityColor: Record<RunEventType, { text: string; bg: string }> =
  {
    "tool-call": { text: "text-blue-500", bg: "bg-blue-500" },
    "tool-input": { text: "text-cyan-500", bg: "bg-cyan-500" },
    reasoning: { text: "text-purple-500", bg: "bg-purple-500" },
    text: { text: "text-amber-500", bg: "bg-amber-500" },
    delegate: { text: "text-emerald-500", bg: "bg-emerald-500" },
    "model-switch": { text: "text-orange-500", bg: "bg-orange-500" },
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
  "tool-input": {
    icon: BracesIcon,
    activeColor: activityColor["tool-input"].text,
    label: (entry) => `Generating arguments for ${entry.toolName ?? "tool"}…`,
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
  "model-switch": {
    icon: RefreshCwIcon,
    activeColor: activityColor["model-switch"].text,
    label: (entry) =>
      entry.modelSwitch
        ? `Switched model: ${entry.modelSwitch.from.model} → ${entry.modelSwitch.to.model}`
        : "Switched model",
  },
  failed: {
    icon: XCircleIcon,
    activeColor: "text-destructive",
    label: () => "Run failed",
  },
};

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
