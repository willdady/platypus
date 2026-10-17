import { useCallback, useMemo, useState } from "react";
import type { Provider, Agent, Chat } from "@platypus/schemas";
import { decodeSelectionReference } from "@/lib/selection-reference";
import {
  resolveRestoredSelection,
  type RestoredSelection,
  type SelectionSubstitution,
  type StoredSelection,
} from "@/lib/restore-selection";

/**
 * Reads the selection this browser remembered for a workspace, or `null` when
 * there is none. It never expires. Storage may be absent (SSR), blocked, or
 * hold something that is not the shape written below; all of those read as "no
 * stored selection" rather than throwing.
 *
 * Values written before the expiry was dropped also carry an `expiresAt`; it
 * is ignored, so a pick made under the old rule is still restored.
 */
const readStoredSelection = (key: string): StoredSelection | null => {
  try {
    const item = localStorage.getItem(key);
    if (!item) return null;
    const stored = JSON.parse(item) as { value?: StoredSelection } | null;
    return stored?.value ?? null;
  } catch {
    return null;
  }
};

/**
 * Persists a pick so the next new Chat in this workspace opens against it. A
 * write that fails (storage full, or blocked) leaves the previous value in
 * place; the pick just won't be remembered.
 */
const writeStoredSelection = (key: string, value: StoredSelection): void => {
  try {
    localStorage.setItem(key, JSON.stringify({ value }));
  } catch {
    // Deliberately swallowed: nothing to recover, and nothing to tell the user.
  }
};

export interface ModelSelection {
  agentId: string;
  modelId: string;
  providerId: string;
}

export interface UseModelSelectionInput {
  /** The Chat's own row, once read; absent for a brand-new Chat. */
  chatData: Chat | undefined;
  providers: Provider[];
  /**
   * `undefined` while the Agent list is still in flight, which is a different
   * thing from a workspace with no Agents: an Agent reference cannot be
   * judged against a list that has not arrived.
   */
  agents: Agent[] | undefined;
  /** Whether the Chat row read is still in flight. */
  isChatLoading?: boolean;
  workspaceId: string;
  /** The Agent named by `?agentId=`, which opens a new Chat against it. */
  initialAgentId?: string;
}

/** What the picker shows before anything has resolved: no selection at all. */
const EMPTY_SELECTION: ModelSelection = {
  agentId: "",
  modelId: "",
  providerId: "",
};

/**
 * Which Agent or Provider/model a Chat is pointed at, and whether that is
 * settled yet.
 *
 * The selection is DERIVED during render rather than committed from an effect
 * (issue #799). An effect cannot run before the first paint, so the picker used
 * to paint its "Select model" empty state and only then swap to the restored
 * Agent — a flash on every new chat, and a whole network round-trip's worth of
 * it for a brand-new Chat, whose row read has to 404 first.
 *
 * `isResolved` is the other half: the ladder needs inputs that arrive
 * asynchronously, so until they have, there is no selection to show and the
 * picker must render a neutral pending state instead of an empty one. An empty
 * `selection` therefore only ever means "nothing to show yet", never "the user
 * has nothing selected".
 */
export const useModelSelection = ({
  chatData,
  providers,
  agents,
  isChatLoading = false,
  workspaceId,
  initialAgentId,
}: UseModelSelectionInput) => {
  const STORAGE_KEY = `platypus:workspace:${workspaceId}:lastSelection`;

  // Read during the first render rather than from an effect: the ladder is
  // consulted before the first paint, and an effect cannot be.
  const [storedSelection, setStoredSelection] = useState(() =>
    readStoredSelection(STORAGE_KEY),
  );

  // What the reader has actually picked in this Chat. `null` means they have
  // not picked anything yet, which is when the restore ladder speaks.
  const [chosen, setChosen] = useState<ModelSelection | null>(null);

  // A workspace switch that reuses this mount starts again from that
  // workspace's own key, rather than carrying the previous workspace's stored
  // value or pick across. React's documented "adjust state during render"
  // pattern (see `useResetOnChange`, which is not used here because its
  // first-render reset would discard the initial read above): the render is
  // discarded and restarted, so nothing resolves against the stale key.
  const [prevKey, setPrevKey] = useState(STORAGE_KEY);
  if (prevKey !== STORAGE_KEY) {
    setPrevKey(STORAGE_KEY);
    setStoredSelection(readStoredSelection(STORAGE_KEY));
    setChosen(null);
  }

  const restored = useMemo<RestoredSelection | null>(() => {
    // Nothing resolves until the inputs the ladder reads have arrived: the row
    // (Priority 1) outranks storage, so committing to a stored selection while
    // the row is still in flight would only trade one flicker for another.
    if (isChatLoading) return null;
    if (providers.length === 0) return null;

    const stored = chatData ? null : storedSelection;

    // An Agent reference — from the row, from storage, or from `?agentId=` —
    // is only resolvable against a loaded Agent list: judged against an absent
    // one it reads as deleted, and the picker cannot label an Agent it cannot
    // find, so it would fall back to the very "Select model" this avoids.
    const needsAgents =
      Boolean(chatData?.agentId) ||
      Boolean(initialAgentId) ||
      stored?.type === "agent";
    if (agents === undefined && needsAgents) return null;

    // `?agentId=` opens a new Chat against that Agent, outranking the stored
    // selection and the first-Provider fallback but not the row's own Agent.
    // A link naming an Agent that no longer exists is no selection at all, so
    // it hands over to the ladder rather than pinning the picker to a dead id.
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

  // Memoised so consumers that key off the selection object (the picker's
  // props bundle, `resolveModel`) see one identity per actual selection.
  const selection = useMemo<ModelSelection>(() => {
    if (chosen) return chosen;
    if (!restored) return EMPTY_SELECTION;
    const { agentId, modelId, providerId } = restored;
    return { agentId, modelId, providerId };
  }, [chosen, restored]);
  // Why the restored selection is not the one asked for. A pick of the
  // user's own supersedes it: they are no longer on the substitute.
  const substitution: SelectionSubstitution | undefined = chosen
    ? undefined
    : restored?.substitution;
  const isResolved = chosen !== null || restored !== null;

  // A pick is the only thing remembered as the Workspace's last selection
  // (Priority 2 of the ladder), so the next new Chat opens against it.
  // Opening a Chat, restoring a new one, the first-Provider fallback and a
  // `?agentId=` link all resolve a selection too, but none is a pick: had
  // they written it, any of them would overwrite the Agent the reader last
  // chose (issue #1503).
  const handleModelChange = useCallback(
    (value: string) => {
      const decoded = decodeSelectionReference(value);
      if (!decoded) return;
      // Exactly one of "an Agent" or "a Provider's model" is ever selected, so
      // each choice clears the other side rather than layering over it.
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
};
