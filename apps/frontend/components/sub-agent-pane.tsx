"use client";

import { useSubAgent } from "@/components/sub-agent-context";
import { SubAgentSessionProvider } from "@/components/sub-agent-session-context";
import { Chat } from "@/components/chat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { XIcon } from "lucide-react";
import { Agent } from "@platypus/schemas";
import { cn } from "@/lib/utils";

interface SubAgentPaneProps {
  orgId: string;
  workspaceId: string;
  agents: Agent[];
}

export const SubAgentPane = ({
  orgId,
  workspaceId,
  agents,
}: SubAgentPaneProps) => {
  const { sessions, activeSessionId, openSession, closePane } = useSubAgent();

  const isOpen = activeSessionId !== null;
  const sessionsArray = Array.from(sessions.values());
  const activeSession = activeSessionId
    ? sessions.get(activeSessionId)
    : undefined;

  if (sessionsArray.length === 0) return null;

  const getAgentName = (subAgentId: string) =>
    agents.find((a) => a.id === subAgentId)?.name || "Sub-Agent";

  return (
    <div
      className={cn(
        "flex flex-col h-full w-[450px] border-l bg-background transition-all duration-300",
        !isOpen &&
          "w-0 border-l-0 overflow-hidden opacity-0 pointer-events-none",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b min-w-[450px]">
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Sub-Agent</Badge>
          {activeSession && (
            <span className="font-medium truncate">
              {getAgentName(activeSession.subAgentId)}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 cursor-pointer"
          onClick={closePane}
        >
          <XIcon className="size-4" />
        </Button>
      </div>

      {/* Task Description */}
      {activeSession?.task && (
        <div className="px-4 py-3 bg-muted/50 border-b min-w-[450px]">
          <div className="text-xs font-medium text-muted-foreground mb-1">
            Task:
          </div>
          <div className="text-sm">{activeSession.task}</div>
        </div>
      )}

      {/* All sessions are rendered but only the active one is visible.
          Using CSS hidden (not conditional rendering) preserves each Chat's
          mounted state, scroll position, and streaming connection. */}
      <div className="flex-1 overflow-hidden min-w-[450px] relative">
        {sessionsArray.map((session) => (
          <div
            key={session.toolCallId}
            className={cn(
              "absolute inset-0",
              session.toolCallId !== activeSessionId && "hidden",
            )}
          >
            <SubAgentSessionProvider toolCallId={session.toolCallId}>
              <Chat
                orgId={orgId}
                workspaceId={workspaceId}
                chatId={session.subChatId}
                initialAgentId={session.subAgentId}
                parentChatId={session.parentChatId}
                initialTask={session.task}
                isSubAgentMode
              />
            </SubAgentSessionProvider>
          </div>
        ))}
      </div>
    </div>
  );
};
