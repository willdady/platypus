"use client";

import { use, useMemo } from "react";
import { Chat } from "@/components/chat";
import { SubAgentPane } from "@/components/sub-agent-pane";
import { SubAgentProvider } from "@/components/sub-agent-context";
import { useSearchParams } from "next/navigation";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Agent } from "@platypus/schemas";

const ChatWithIdPage = ({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string; chatId: string }>;
}) => {
  const { orgId, workspaceId, chatId } = use(params);
  const searchParams = useSearchParams();
  const agentId = searchParams.get("agentId") || undefined;

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  // Fetch agents for the sub-agent pane
  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    backendUrl && user
      ? joinUrl(backendUrl, `/organizations/${orgId}/workspaces/${workspaceId}/agents`)
      : null,
    fetcher,
  );
  // Memoize agents to prevent unnecessary re-renders of Chat components
  const agents = useMemo(
    () => agentsData?.results || [],
    [agentsData?.results]
  );

  return (
    <SubAgentProvider key={chatId}>
      <div className="flex h-full">
        {/* Main Chat Area */}
        <div className="flex-1 min-w-0">
          <Chat
            orgId={orgId}
            workspaceId={workspaceId}
            chatId={chatId}
            initialAgentId={agentId}
          />
        </div>

        {/* Sub-Agent Side Pane */}
        <SubAgentPane orgId={orgId} workspaceId={workspaceId} agents={agents} />
      </div>
    </SubAgentProvider>
  );
};

export default ChatWithIdPage;
