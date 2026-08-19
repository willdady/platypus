import { useState, useEffect } from "react";
import { Provider, Agent, Chat } from "@platypus/schemas";
import { setWithExpiry, getWithExpiry } from "@/lib/local-storage";
import { decodeSelectionReference } from "@/lib/selection-reference";
import {
  resolveRestoredSelection,
  type StoredSelection,
} from "@/lib/restore-selection";

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
    const decoded = decodeSelectionReference(value);
    if (!decoded) return;
    if (decoded.type === "agent") {
      setAgentId(decoded.agentId);
      setProviderId(""); // Clear provider/model
      setModelId("");
    } else {
      setProviderId(decoded.providerId);
      setModelId(decoded.modelReference);
      setAgentId(""); // Clear agent
    }
  };

  // Restore persisted agent/provider/model from chat data or localStorage.
  // This runs once the async providers/agents/chat data are available (and
  // only while nothing is selected), reading client-only localStorage — work
  // that belongs in an effect, so the restoring setState calls below are
  // intentional. The three-priority ladder itself (chatData → localStorage →
  // first provider's first model) is `resolveRestoredSelection`, a pure
  // function tested on its own without a DOM or storage stub.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (isLoading || providers.length === 0) return;

    // If we already have a selection, do nothing
    if (modelId || providerId || agentId) return;

    const restored = resolveRestoredSelection({
      chatData,
      storedSelection: chatData
        ? null
        : getWithExpiry<StoredSelection>(STORAGE_KEY),
      providers,
      agents,
    });
    if (!restored) return;

    setAgentId(restored.agentId);
    setModelId(restored.modelId);
    setProviderId(restored.providerId);
    /* eslint-enable react-hooks/set-state-in-effect */
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
