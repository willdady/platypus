import { useCallback, useMemo, useState } from "react";
import type { Provider, Agent, Chat } from "@platypus/schemas";
import { decodeSelectionReference } from "@/lib/selection-reference";
import {
  resolveRestoredSelection,
  type RestoredSelection,
  type SelectionSubstitution,
  type StoredSelection,
} from "@/lib/restore-selection";
import type { Serialized } from "@/lib/api-write";

function readStoredSelection(key: string): StoredSelection | null {
  try {
    const item = localStorage.getItem(key);
    if (!item) return null;
    const stored = JSON.parse(item) as { value?: StoredSelection } | null;
    return stored?.value ?? null;
  } catch {
    return null;
  }
}

function writeStoredSelection(key: string, value: StoredSelection): void {
  try {
    localStorage.setItem(key, JSON.stringify({ value }));
  } catch {
    // why: nothing to recover and nothing the user could act on
  }
}

export type ModelSelection = {
  agentId: string;
  modelId: string;
  providerId: string;
};

export type UseModelSelectionInput = {
  chatData: Serialized<Chat> | undefined;
  providers: Serialized<Provider>[];
  agents: Serialized<Agent>[] | undefined;
  isChatLoading?: boolean;
  workspaceId: string;
  initialAgentId?: string;
};

const EMPTY_SELECTION: ModelSelection = {
  agentId: "",
  modelId: "",
  providerId: "",
};

export function useModelSelection({
  chatData,
  providers,
  agents,
  isChatLoading = false,
  workspaceId,
  initialAgentId,
}: UseModelSelectionInput) {
  const STORAGE_KEY = `platypus:workspace:${workspaceId}:lastSelection`;

  const [storedSelection, setStoredSelection] = useState(() =>
    readStoredSelection(STORAGE_KEY),
  );

  const [chosen, setChosen] = useState<ModelSelection | null>(null);

  const [prevKey, setPrevKey] = useState(STORAGE_KEY);
  if (prevKey !== STORAGE_KEY) {
    setPrevKey(STORAGE_KEY);
    setStoredSelection(readStoredSelection(STORAGE_KEY));
    setChosen(null);
  }

  const restored = useMemo<RestoredSelection | null>(() => {
    if (isChatLoading) return null;
    if (providers.length === 0) return null;

    const stored = chatData ? null : storedSelection;

    const needsAgents =
      Boolean(chatData?.agentId) ||
      Boolean(initialAgentId) ||
      stored?.type === "agent";
    if (agents === undefined && needsAgents) return null;

    if (
      initialAgentId &&
      !chatData?.agentId &&
      agents?.some((a) => a.id === initialAgentId)
    ) {
      return { agentId: initialAgentId, modelId: "", providerId: "" };
    }

    return resolveRestoredSelection({
      chatData,
      storedSelection: stored,
      providers,
      agents: agents ?? [],
    });
  }, [
    chatData,
    providers,
    agents,
    isChatLoading,
    storedSelection,
    initialAgentId,
  ]);

  // why: memoised, so consumers see one identity per actual selection
  const selection = useMemo<ModelSelection>(() => {
    if (chosen) return chosen;
    if (!restored) return EMPTY_SELECTION;
    const { agentId, modelId, providerId } = restored;
    return { agentId, modelId, providerId };
  }, [chosen, restored]);
  const substitution: SelectionSubstitution | undefined = chosen
    ? undefined
    : restored?.substitution;
  const isResolved = chosen !== null || restored !== null;

  const handleModelChange = useCallback(
    (value: string) => {
      const decoded = decodeSelectionReference(value);
      if (!decoded) return;
      const stored: StoredSelection =
        decoded.type === "agent"
          ? { type: "agent", id: decoded.agentId }
          : {
              type: "provider",
              providerId: decoded.providerId,
              modelId: decoded.modelReference,
            };
      setChosen(
        stored.type === "agent"
          ? { agentId: stored.id, modelId: "", providerId: "" }
          : {
              agentId: "",
              providerId: stored.providerId,
              modelId: stored.modelId,
            },
      );
      writeStoredSelection(STORAGE_KEY, stored);
    },
    [STORAGE_KEY],
  );

  return { selection, isResolved, substitution, handleModelChange };
}
