"use client";

import { Badge } from "@/components/ui/badge";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { DynamicToolUIPart } from "ai";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ReactNode } from "react";

export type DynamicToolHeaderProps = {
  title: string;
  state: DynamicToolUIPart["state"];
  /** ISO timestamp of when this tool call began, if known. */
  startedAt?: string;
  className?: string;
};

const formatToolTime = (iso: string): string | undefined => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const getStatusBadge = (status: DynamicToolUIPart["state"]) => {
  const labels: Record<DynamicToolUIPart["state"], string> = {
    "input-streaming": "Pending",
    "input-available": "Running",
    "output-available": "Completed",
    "output-error": "Error",
    "approval-requested": "Approval Requested",
    "approval-responded": "Approval Responded",
    "output-denied": "Denied",
  };

  const icons: Record<DynamicToolUIPart["state"], ReactNode> = {
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

export const DynamicToolHeader = ({
  className,
  title,
  state,
  startedAt,
  ...props
}: DynamicToolHeaderProps) => {
  const time = startedAt ? formatToolTime(startedAt) : undefined;
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-4 p-3",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2">
        <WrenchIcon className="size-4 text-muted-foreground" />
        <span className="font-medium text-sm">{title}</span>
        {getStatusBadge(state)}
        {time && (
          <span className="text-xs text-muted-foreground shrink-0">{time}</span>
        )}
      </div>
      <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};
