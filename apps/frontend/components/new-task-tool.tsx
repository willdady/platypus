"use client";

import { useSubAgent } from "@/components/sub-agent-context";
import { useEffect } from "react";
import { ToolUIPart } from "ai";
import { Loader2Icon, CheckCircle, XCircle } from "lucide-react";
import { type Agent } from "@platypus/schemas";

interface NewTaskToolProps {
  toolPart: ToolUIPart;
  parentChatId: string;
  agents: Agent[];
}

export const NewTaskTool = ({
  toolPart,
  parentChatId,
  agents,
}: NewTaskToolProps) => {
  const { startSession, openSession, getSession, isToolCallCompleted } =
    useSubAgent();
  const input = toolPart.input as { subAgentId: string; task: string };
  const session = getSession(toolPart.toolCallId);
  const completed = isToolCallCompleted(toolPart.toolCallId);

  const agentName =
    agents.find((a) => a.id === input?.subAgentId)?.name || "Sub-agent";

  // Start a sub-agent session when the tool call input becomes available.
  // Guards prevent re-launching if a session already exists (e.g. re-render)
  // or if this tool call was restored from persisted chat history.
  useEffect(() => {
    if (
      toolPart.state === "input-available" &&
      input?.subAgentId &&
      input?.task &&
      !session &&
      !completed
    ) {
      startSession(
        parentChatId,
        toolPart.toolCallId,
        input.subAgentId,
        input.task,
      );
    }
  }, [
    toolPart.state,
    toolPart.toolCallId,
    input,
    parentChatId,
    startSession,
    session,
    completed,
  ]);

  if (toolPart.state === "input-streaming") {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
        <Loader2Icon className="size-4 animate-spin" />
        <span>Preparing to delegate task...</span>
      </div>
    );
  }

  const handleClick = () => {
    if (session) {
      openSession(toolPart.toolCallId);
    }
  };

  // Completed with success
  if (session?.result?.status === "success") {
    return (
      <div
        className="flex items-center gap-2 text-sm py-2 cursor-pointer hover:text-foreground text-muted-foreground transition-colors"
        onClick={handleClick}
      >
        <CheckCircle className="size-4 text-green-500" />
        <span>{agentName} completed task</span>
      </div>
    );
  }

  // Completed with error
  if (session?.result?.status === "error") {
    return (
      <div
        className="flex items-center gap-2 text-sm py-2 cursor-pointer hover:text-foreground text-muted-foreground transition-colors"
        onClick={handleClick}
      >
        <XCircle className="size-4 text-red-500" />
        <span>{agentName} failed task</span>
      </div>
    );
  }

  // Running (session exists, no result yet)
  return (
    <div
      className="flex items-center gap-2 text-muted-foreground text-sm py-2 cursor-pointer hover:text-foreground transition-colors"
      onClick={handleClick}
    >
      <Loader2Icon className="size-4 animate-spin" />
      <span>{agentName} working...</span>
    </div>
  );
};
