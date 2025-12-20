import { useEffect, useRef } from "react";
import { UIMessage } from "ai";
import { Agent } from "@platypus/schemas";
import { mutate } from "swr";

export const useChatMetadata = (
  messages: UIMessage[],
  status: string,
  chatId: string,
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
      fetch(`${backendUrl}/chat/${chatId}?workspaceId=${workspaceId}`)
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
                `${backendUrl}/chat/${chatId}/generate-metadata?workspaceId=${workspaceId}`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ providerId: providerIdForMetadata }),
                },
              )
                .then(() => {
                  // Revalidate the chat list
                  mutate(`${backendUrl}/chat?workspaceId=${workspaceId}`);
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
    workspaceId,
    providerId,
    agentId,
    agents,
    backendUrl,
  ]);
};
