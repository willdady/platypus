"use client";

import {
  CheckCircleIcon,
  CircleIcon,
  ClockIcon,
  SparklesIcon,
  XCircleIcon,
} from "lucide-react";
import type { ToolUIPart } from "ai";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { type PlatypusTools } from "@platypus/backend/src/types";

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

interface LoadSkillToolProps {
  toolPart: ToolUIPart;
}

export const LoadSkillTool = ({ toolPart }: LoadSkillToolProps) => {
  const input = toolPart.input as PlatypusTools["loadSkill"]["input"];
  const output = toolPart.output as PlatypusTools["loadSkill"]["output"];
  const errorText =
    toolPart.errorText ||
    (output && "error" in output ? (output.error as string) : null);

  return (
    <div className="not-prose mb-4 w-full rounded-md border">
      <div className="flex items-center justify-between gap-4 p-3">
        <div className="flex items-center gap-2">
          <SparklesIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">
            Loading skill{input?.name ? `: ${input.name}` : ""}
          </span>
          {getStatusBadge(errorText ? "output-error" : toolPart.state)}
        </div>
      </div>
      {errorText && (
        <div className="px-3 pb-3 text-destructive text-xs">{errorText}</div>
      )}
    </div>
  );
};
