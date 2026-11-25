import type { Agent, Chat, Provider } from "@platypus/schemas";
import { findModelOption, getModelOptions } from "./model-config";
import type { Serialized } from "./api-write";

export type StoredSelection =
  | { type: "agent"; id: string }
  | { type: "provider"; providerId: string; modelId: string };

export type RestoreLadderInput = {
  chatData: Pick<Chat, "agentId" | "providerId" | "modelId"> | undefined;
  storedSelection: StoredSelection | null;
  providers: Serialized<Provider>[];
  agents: Serialized<Agent>[];
};

export type SelectionSubstitution = {
  missing: "agent" | "provider" | "model";
  source: "chat" | "lastUsed";
};

export type RestoredSelection = {
  agentId: string;
  modelId: string;
  providerId: string;
  substitution?: SelectionSubstitution;
};

export function resolveRestoredSelection(
  input: RestoreLadderInput,
): RestoredSelection | null {
  const { chatData, storedSelection, providers, agents } = input;

  if (providers.length === 0) return null;

  let substitution: SelectionSubstitution | undefined;
  const substituted = (selection: RestoredSelection): RestoredSelection =>
    substitution ? { ...selection, substitution } : selection;

  if (chatData) {
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

    if (chatData.agentId) substitution ??= { missing: "agent", source: "chat" };
  }

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

  const fallbackProvider = providers[0];
  return substituted({
    agentId: "",
    providerId: fallbackProvider.id,
    modelId: getModelOptions(fallbackProvider)[0]?.value ?? "",
  });
}
