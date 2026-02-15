"use client";

import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  BotIcon,
  XCircleIcon,
} from "lucide-react";
import type { ToolUIPart, TextUIPart, UIMessage, DynamicToolUIPart } from "ai";
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
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "./ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "./ai-elements/tool";
import { DynamicToolHeader } from "./dynamic-tool-header";
import { LoadSkillTool } from "./load-skill-tool";
import type { ReactNode } from "react";

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
 * e.g., "delegate_to_dad_joke_bot" -> "Dad Joke Bot"
 */
const extractSubAgentName = (toolName: string): string => {
  const prefix = "delegate_to_";
  if (toolName.startsWith(prefix)) {
    const namePart = toolName.slice(prefix.length);
    // Convert snake_case to Title Case
    return namePart
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }
  return toolName;
};

interface SubAgentToolProps {
  toolPart: ToolUIPart;
}

/**
 * Renders a sub-agent tool invocation with a robot icon and nested chat UI.
 * When expanded, shows the sub-agent's response as a chat message including
 * reasoning and tool calls, similar to the main chat.
 */
export const SubAgentTool = ({ toolPart }: SubAgentToolProps) => {
  const input = toolPart.input as { task?: string };
  const output = toolPart.output as UIMessage | null;
  const errorText = toolPart.errorText;
  const subAgentName = extractSubAgentName(toolPart.type.replace("tool-", ""));

  // Render the sub-agent's output message parts similar to the main chat
  const renderSubAgentMessage = () => {
    if (!output || !output.parts) return null;

    return output.parts.map((part, index) => {
      if (part.type === "text") {
        const textPart = part as TextUIPart;
        return (
          <Message key={`text-${index}`} from="assistant">
            <MessageContent className="max-w-full">
              <MessageResponse>{textPart.text}</MessageResponse>
            </MessageContent>
          </Message>
        );
      } else if (part.type === "reasoning") {
        return (
          <Reasoning key={`reasoning-${index}`} defaultOpen={false}>
            <ReasoningTrigger className="cursor-pointer" />
            <ReasoningContent>{part.text}</ReasoningContent>
          </Reasoning>
        );
      } else if (part.type === "dynamic-tool") {
        const toolPartInner = part as DynamicToolUIPart;
        return (
          <Tool key={`tool-${index}`}>
            <DynamicToolHeader
              state={toolPartInner.state}
              title={toolPartInner.toolName}
            />
            <ToolContent>
              <ToolInput input={toolPartInner.input} />
              <ToolOutput
                output={toolPartInner.output}
                errorText={toolPartInner.errorText}
              />
            </ToolContent>
          </Tool>
        );
      } else if (part.type === "tool-loadSkill") {
        return (
          <LoadSkillTool key={`tool-${index}`} toolPart={part as ToolUIPart} />
        );
      } else if (part.type.startsWith("tool-delegate_to_")) {
        // Nested sub-agent calls should NOT happen - backend enforces this
        // If this appears, it's an error - show a warning instead of recursing
        const nestedToolPart = part as ToolUIPart;
        const nestedName = extractSubAgentName(
          nestedToolPart.type.replace("tool-", ""),
        );
        return (
          <Tool key={`tool-${index}`}>
            <ToolHeader state="output-error" type={nestedToolPart.type} />
            <ToolContent>
              <div className="p-3 text-destructive text-sm">
                Error: Sub-agent "{nestedName}" cannot call other sub-agents.
                This should not happen - the backend should prevent sub-agents
                from having delegate tools.
              </div>
            </ToolContent>
          </Tool>
        );
      } else if (part.type.startsWith("tool-")) {
        const toolPartInner = part as ToolUIPart;
        return (
          <Tool key={`tool-${index}`}>
            <ToolHeader state={toolPartInner.state} type={toolPartInner.type} />
            <ToolContent>
              <ToolInput input={toolPartInner.input} />
              <ToolOutput
                output={toolPartInner.output}
                errorText={toolPartInner.errorText}
              />
            </ToolContent>
          </Tool>
        );
      }
      // Skip other part types
      return null;
    });
  };

  return (
    <Collapsible className="not-prose mb-4 w-full rounded-md border group">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 p-3">
        <div className="flex items-center gap-2">
          <BotIcon className="size-4 text-muted-foreground" />
          <span className="font-medium text-sm">{subAgentName}</span>
          {getStatusBadge(errorText ? "output-error" : toolPart.state)}
        </div>
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
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

        {/* Error or Response (chat-like) */}
        {errorText ? (
          <div className="space-y-2 border-t p-4">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Error
            </h4>
            <div className="rounded-md bg-destructive/10 p-3 text-destructive text-sm">
              {errorText}
            </div>
          </div>
        ) : output ? (
          <div className="space-y-2 border-t p-4">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Response
            </h4>
            <div className="flex flex-col gap-2">{renderSubAgentMessage()}</div>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
};
