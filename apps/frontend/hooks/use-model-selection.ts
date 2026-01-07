import { useState, useEffect } from "react";
import { Provider, Agent, Chat } from "@platypus/schemas";
import { setWithExpiry, getWithExpiry } from "@/lib/local-storage";

export interface ModelSelection {
  agentId: string;
  modelId: string;
  providerId: string;
}

export const useModelSelection = (
  chatData: Chat | undefined,
  providers: Provider[],
  agents: Agent[],
  isLoading: boolean = false,
  workspaceId: string,
) => {
  const [agentId, setAgentId] = useState("");
  const [modelId, setModelId] = useState("");
  const [providerId, setProviderId] = useState("");

  const STORAGE_KEY = `platypus:workspace:${workspaceId}:lastSelection`;

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

  // Restore persisted agent/provider/model from chat data or localStorage, with validation and fallback
  useEffect(() => {
    if (isLoading || providers.length === 0) return;

    // If we already have a selection, do nothing
    if (modelId || providerId || agentId) return;

    // PRIORITY 1: Restore from chatData (existing chat)
    if (chatData) {
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

      // Restore provider/model from chatData
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
    }

    // PRIORITY 2: Try to restore from localStorage (for NEW chats only)
    if (!chatData) {
      const lastSelection = getWithExpiry<{
        type: "agent" | "provider";
        id?: string;
        providerId?: string;
        modelId?: string;
      }>(STORAGE_KEY);

      if (lastSelection) {
        if (lastSelection.type === "agent" && lastSelection.id) {
          const agent = agents.find((a) => a.id === lastSelection.id);
          if (agent) {
            setAgentId(lastSelection.id);
            return;
          }
          console.warn(
            `Agent '${lastSelection.id}' from localStorage no longer exists`,
          );
        } else if (
          lastSelection.type === "provider" &&
          lastSelection.providerId &&
          lastSelection.modelId
        ) {
          const provider = providers.find(
            (p) => p.id === lastSelection.providerId,
          );
          if (provider?.modelIds.includes(lastSelection.modelId)) {
            setProviderId(lastSelection.providerId);
            setModelId(lastSelection.modelId);
            return;
          }
          console.warn(`Provider/model from localStorage no longer valid`);
        }
      }
    }

    // PRIORITY 3: Fall back to first provider's first model (for new chats, invalid persisted data, or missing chatData)
    setModelId(providers[0].modelIds[0]);
    setProviderId(providers[0].id);
  }, [
    chatData,
    providers,
    agents,
    modelId,
    providerId,
    agentId,
    isLoading,
    workspaceId,
    STORAGE_KEY,
  ]);

  // Persist selection to localStorage when it changes
  useEffect(() => {
    if (!agentId && !providerId && !modelId) return; // Don't save empty state

    if (agentId) {
      setWithExpiry(STORAGE_KEY, { type: "agent", id: agentId });
    } else if (providerId && modelId) {
      setWithExpiry(STORAGE_KEY, { type: "provider", providerId, modelId });
    }
  }, [agentId, providerId, modelId, STORAGE_KEY]);

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
