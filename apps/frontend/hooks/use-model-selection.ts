import { useState, useEffect } from "react";
import { Provider, Agent, Chat } from "@agent-kit/schemas";

export interface ModelSelection {
  agentId: string;
  modelId: string;
  providerId: string;
}

export const useModelSelection = (
  chatData: Chat | undefined,
  providers: Provider[],
  agents: Agent[],
) => {
  const [agentId, setAgentId] = useState("");
  const [modelId, setModelId] = useState("");
  const [providerId, setProviderId] = useState("");

  const handleModelChange = (value: string) => {
    if (value.startsWith("agent:")) {
      // Agent selected
      const newAgentId = value.replace("agent:", "");
      setAgentId(newAgentId);
      setProviderId(""); // Clear provider/model
      setModelId("");
    } else if (value.startsWith("provider:")) {
      // Provider/model selected
      const [_, newProviderId, ...modelIdParts] = value.split(":");
      const newModelId = modelIdParts.join(":");
      setProviderId(newProviderId);
      setModelId(newModelId);
      setAgentId(""); // Clear agent
    }
  };

  // Restore persisted agent/provider/model from chat data, with validation and fallback
  useEffect(() => {
    if (
      chatData &&
      providers.length > 0 &&
      !modelId &&
      !providerId &&
      !agentId
    ) {
      // Check if chat has an agent
      if (chatData.agentId && agents.length > 0) {
        const agent = agents.find((a) => a.id === chatData.agentId);
        if (agent) {
          // Agent still exists, restore it
          setAgentId(chatData.agentId);
          return;
        } else {
          // Agent was deleted, fall back to provider/model
          console.warn(`Agent '${chatData.agentId}' no longer exists`);
        }
      }

      // Restore provider/model (existing logic)
      const persistedProviderId = chatData.providerId;
      const persistedModelId = chatData.modelId;

      if (persistedProviderId && persistedModelId) {
        // Check if the persisted provider still exists
        const provider = providers.find((p) => p.id === persistedProviderId);
        if (provider) {
          // Check if the persisted model is still available for this provider
          if (provider.modelIds.includes(persistedModelId)) {
            // Both provider and model are valid, restore them
            setProviderId(persistedProviderId);
            setModelId(persistedModelId);
            return;
          } else {
            // Provider exists but model is no longer available, use provider's first model
            console.warn(
              `Model '${persistedModelId}' no longer available for provider '${persistedProviderId}', falling back to first model`,
            );
            setProviderId(persistedProviderId);
            setModelId(provider.modelIds[0]);
            return;
          }
        } else {
          // Provider no longer exists, fall back to first available provider
          console.warn(
            `Provider '${persistedProviderId}' no longer exists, falling back to first available provider`,
          );
        }
      }

      // Fall back to first provider's first model (for new chats or invalid persisted data)
      setModelId(providers[0].modelIds[0]);
      setProviderId(providers[0].id);
    }
  }, [chatData, providers, agents, modelId, providerId, agentId]);

  const selection: ModelSelection = {
    agentId,
    modelId,
    providerId,
  };

  const setters = {
    setAgentId,
    setModelId,
    setProviderId,
  };

  return { selection, setters, handleModelChange, ...setters };
};
