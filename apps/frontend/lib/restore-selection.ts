import type { Agent, Chat, Provider } from "@platypus/schemas";
import { findModelOption, getModelOptions } from "./model-config";
import type { Serialized } from "./api-write";

/** The shape a Chat's last selection is persisted as under its localStorage key. */
export type StoredSelection =
  | { type: "agent"; id: string }
  | { type: "provider"; providerId: string; modelId: string };

export type RestoreLadderInput = {
  /** Present when restoring an existing Chat; absent for a brand-new one. */
  chatData: Pick<Chat, "agentId" | "providerId" | "modelId"> | undefined;
  /** The Chat's last selection read from localStorage, or `null` if none/expired. */
  storedSelection: StoredSelection | null;
  providers: Serialized<Provider>[];
  agents: Serialized<Agent>[];
};

/**
 * Why the ladder opened a Chat against something other than what it asked
 * for: which reference was gone, and whose it was — the Chat's own row, or
 * the selection this browser last used in the Workspace.
 */
export type SelectionSubstitution = {
  missing: "agent" | "provider" | "model";
  source: "chat" | "lastUsed";
};

export type RestoredSelection = {
  agentId: string;
  modelId: string;
  providerId: string;
  /** Present only when the selection asked for could not be honoured. */
  substitution?: SelectionSubstitution;
};

/**
 * The three-priority restore ladder that decides which model a Chat opens
 * against: an existing Chat's own selection, then a new Chat's last-used
 * localStorage selection, then the first available Provider's first model.
 * Pure — takes the already-read localStorage value rather than reading it
 * itself — so every fallback (a deleted Agent, a removed Provider, an aliased
 * model, empty storage) is testable without a DOM or storage stub.
 *
 * When a reference it was asked to restore is gone, the result carries a
 * `substitution` saying which, so the Chat can tell the user it is not
 * talking to the model they last used rather than switching silently.
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

  // The first reference found missing; later rungs keep it, since it is the
  // one the user would recognise.
  let substitution: SelectionSubstitution | undefined;
  const substituted = (selection: RestoredSelection): RestoredSelection =>
    substitution ? { ...selection, substitution } : selection;

  // PRIORITY 1: restore from chatData (existing chat).
  if (chatData) {
    // Only judge the Agent reference once `agents` has actually loaded —
    // agents.length === 0 while data is still in flight looks identical to a
    // genuinely empty list, and treating it as "deleted" would fall through to
    // Priority 3 before the real Agent ever gets a chance to match. The hook
    // now holds a Chat back rather than resolve it against a list still in
    // flight (issue #799), so this is the backstop, not the only guard.
    if (chatData.agentId && agents.length > 0) {
      const agent = agents.find((a) => a.id === chatData.agentId);
      if (agent) {
        return { agentId: chatData.agentId, modelId: "", providerId: "" };
      }
      substitution = { missing: "agent", source: "chat" };
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
          return substituted({
            agentId: "",
            modelId: option.value,
            providerId: chatData.providerId,
          });
        }
        substitution ??= { missing: "model", source: "chat" };
        return substituted({
          agentId: "",
          providerId: chatData.providerId,
          modelId: getModelOptions(provider)[0]?.value ?? "",
        });
      }
      substitution ??= { missing: "provider", source: "chat" };
    }

    // An Agent Chat that reaches the fallback lost its Agent, even when the
    // list was empty and so never judged above.
    if (chatData.agentId) substitution ??= { missing: "agent", source: "chat" };
  }

  // PRIORITY 2: restore from localStorage (new chats only).
  if (!chatData && storedSelection) {
    if (storedSelection.type === "agent") {
      const agent = agents.find((a) => a.id === storedSelection.id);
      if (agent) {
        return { agentId: storedSelection.id, modelId: "", providerId: "" };
      }
      substitution = { missing: "agent", source: "lastUsed" };
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
      substitution = {
        missing: provider ? "model" : "provider",
        source: "lastUsed",
      };
    }
  }

  // PRIORITY 3: fall back to the first provider's first model.
  const fallbackProvider = providers[0];
  return substituted({
    agentId: "",
    providerId: fallbackProvider.id,
    modelId: getModelOptions(fallbackProvider)[0]?.value ?? "",
  });
};
