"use client";

import { useSubAgent } from "@/components/sub-agent-context";
import { useSubAgentSession } from "@/components/sub-agent-session-context";
import { useEffect } from "react";
import { ToolUIPart } from "ai";
import { CheckCircle, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface TaskResultToolProps {
  toolPart: ToolUIPart;
}

export const TaskResultTool = ({ toolPart }: TaskResultToolProps) => {
  const { completeSession } = useSubAgent();
  const { toolCallId } = useSubAgentSession();
  const input = toolPart.input as {
    result: string;
    status: "success" | "error";
  };

  // When the sub-agent model calls the taskResult tool, mark the session as
  // complete. The toolCallId comes from SubAgentSessionProvider which wraps
  // this Chat instance, linking it back to the parent's newTask tool call.
  useEffect(() => {
    if (toolPart.state === "input-available" && input?.result) {
      completeSession(toolCallId, input);
    }
  }, [toolPart.state, input, completeSession, toolCallId]);

  if (!input?.result) return null;

  return (
    <div className="border rounded-lg p-4 bg-muted/50 my-2">
      <div className="flex items-center gap-2 mb-2">
        {input.status === "success" ? (
          <CheckCircle className="size-4 text-green-500" />
        ) : (
          <XCircle className="size-4 text-red-500" />
        )}
        <Badge
          variant={input.status === "success" ? "default" : "destructive"}
        >
          Task {input.status === "success" ? "Completed" : "Failed"}
        </Badge>
      </div>
      <div className="text-sm whitespace-pre-wrap">{input.result}</div>
    </div>
  );
};
