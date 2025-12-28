import { useEffect, useRef } from "react";
import { UIMessage } from "ai";
import { Agent } from "@platypus/schemas";
import { mutate } from "swr";
import { joinUrl } from "@/lib/utils";

export const useChatMetadata = (
  messages: UIMessage[],
  status: string,
  chatId: string,
  orgId: string,
  workspaceId: string,
  providerId: string,
  agentId: string,
  agents: Agent[],
  backendUrl: string,
) => {
  const hasMutatedRef = useRef(false);

  // Reset hasMutated when chatId changes
  useEffect(() => {
    hasMutatedRef.current = false;
  }, [chatId]);

  // Revalidate the chat list (visible in AppSidebar) when our message array contains exactly 2 messages.
  // This will be true after the first successful response from the backend for a new chat.
  // Only generate a title if the chat has "Untitled" as the title.
  useEffect(() => {
    if (messages.length === 2 && !hasMutatedRef.current && status === "ready") {
      hasMutatedRef.current = true;
      // First, revalidate chat data to ensure we have the latest chat record from the backend
      fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}`,
        ),
        { credentials: "include" },
      )
        .then((res) => res.json())
        .then((freshChatData) => {
          // Only generate title if the chat has "Untitled" as its title
          if (freshChatData?.title === "Untitled") {
            // Determine the correct providerId to use for metadata generation
            let providerIdForMetadata = providerId;

            if (agentId) {
              // Agent is selected - use the agent's providerId
              const agent = agents.find((a) => a.id === agentId);
              if (agent?.providerId) {
                providerIdForMetadata = agent.providerId;
              } else {
                console.warn(
                  `Agent '${agentId}' not found or missing providerId, falling back to current providerId`,
                );
              }
            }

            // Validate that we have a providerId before making the request
            if (providerIdForMetadata) {
              // Call generate-metadata endpoint
              fetch(
                joinUrl(
                  backendUrl,
                  `/organizations/${orgId}/workspaces/${workspaceId}/chat/${chatId}/generate-metadata`,
                ),
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  credentials: "include",
                  body: JSON.stringify({ providerId: providerIdForMetadata }),
                },
              )
                .then(() => {
                  // Revalidate the chat list
                  mutate(
                    joinUrl(
                      backendUrl,
                      `/organizations/${orgId}/workspaces/${workspaceId}/chat`,
                    ),
                  );
                })
                .catch((error) => {
                  console.error("Failed to generate chat metadata:", error);
                });
            } else {
              console.warn("No providerId available for metadata generation");
            }
          }
        })
        .catch((error) => {
          console.error("Failed to fetch fresh chat data:", error);
        });
    }
  }, [
    messages,
    status,
    chatId,
    orgId,
    workspaceId,
    providerId,
    agentId,
    agents,
    backendUrl,
  ]);
};
