import type { Agent, Chat, Provider } from "@platypus/schemas";
import { findModelOption, getModelOptions } from "./model-config";

/** The shape a Chat's last selection is persisted as under its localStorage key. */
export type StoredSelection =
  | { type: "agent"; id: string }
  | { type: "provider"; providerId: string; modelId: string };

export type RestoreLadderInput = {
  /** Present when restoring an existing Chat; absent for a brand-new one. */
  chatData: Pick<Chat, "agentId" | "providerId" | "modelId"> | undefined;
  /** The Chat's last selection read from localStorage, or `null` if none/expired. */
  storedSelection: StoredSelection | null;
  providers: Provider[];
  agents: Agent[];
};

export type RestoredSelection = {
  agentId: string;
  modelId: string;
  providerId: string;
};

/**
 * The three-priority restore ladder that decides which model a Chat opens
 * against: an existing Chat's own selection, then a new Chat's last-used
 * localStorage selection, then the first available Provider's first model.
 * Pure — takes the already-read localStorage value rather than reading it
 * itself — so every fallback (a deleted Agent, a removed Provider, an aliased
 * model, empty storage) is testable without a DOM or storage stub.
 *
 * Returns `null` only when there is no Provider to fall back to, meaning
 * nothing can be resolved yet — the caller should leave its state as-is
 * rather than committing an empty selection.
 */
export const resolveRestoredSelection = (
  input: RestoreLadderInput,
): RestoredSelection | null => {
  const { chatData, storedSelection, providers, agents } = input;

  if (providers.length === 0) return null;

  // PRIORITY 1: restore from chatData (existing chat).
  if (chatData) {
    // Only judge the Agent reference once `agents` has actually loaded —
    // agents.length === 0 while data is still in flight looks identical to a
    // genuinely empty list, and treating it as "deleted" would fall through to
    // Priority 3 before the real Agent ever gets a chance to match.
    if (chatData.agentId && agents.length > 0) {
      const agent = agents.find((a) => a.id === chatData.agentId);
      if (agent) {
        return { agentId: chatData.agentId, modelId: "", providerId: "" };
      }
      console.warn(`Agent '${chatData.agentId}' no longer exists`);
    }

    if (chatData.providerId && chatData.modelId) {
      const provider = providers.find((p) => p.id === chatData.providerId);
      if (provider) {
        // Resolve to a model ENTRY rather than testing string membership: once
        // a model is given an alias its option value becomes `alias:<name>`,
        // so a stored bare id would fail a plain equality check and silently
        // fall through to a different model (ADR-0017).
        const option = findModelOption(provider, chatData.modelId);
        if (option) {
          return {
            agentId: "",
            modelId: option.value,
            providerId: chatData.providerId,
          };
        }
        console.warn(
          `Model '${chatData.modelId}' no longer available for provider '${chatData.providerId}', falling back to first model`,
        );
        return {
          agentId: "",
          providerId: chatData.providerId,
          modelId: getModelOptions(provider)[0]?.value ?? "",
        };
      }
      console.warn(
        `Provider '${chatData.providerId}' no longer exists, falling back to first available provider`,
      );
    }
  }

  // PRIORITY 2: restore from localStorage (new chats only).
  if (!chatData && storedSelection) {
    if (storedSelection.type === "agent") {
      const agent = agents.find((a) => a.id === storedSelection.id);
      if (agent) {
        return { agentId: storedSelection.id, modelId: "", providerId: "" };
      }
      console.warn(
        `Agent '${storedSelection.id}' from localStorage no longer exists`,
      );
    } else {
      const provider = providers.find(
        (p) => p.id === storedSelection.providerId,
      );
      const option =
        provider && findModelOption(provider, storedSelection.modelId);
      if (option) {
        return {
          agentId: "",
          providerId: storedSelection.providerId,
          modelId: option.value,
        };
      }
      console.warn("Provider/model from localStorage no longer valid");
    }
  }

  // PRIORITY 3: fall back to the first provider's first model.
  const fallbackProvider = providers[0];
  return {
    agentId: "",
    providerId: fallbackProvider.id,
    modelId: getModelOptions(fallbackProvider)[0]?.value ?? "",
  };
};
