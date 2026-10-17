import { useCallback, useState } from "react";
import type { Chat } from "@platypus/schemas";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import type { Serialized } from "@/lib/api-write";

export interface ChatSettings {
  instructions: string;
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  seed: number | undefined;
  presencePenalty: number | undefined;
  frequencyPenalty: number | undefined;
  maxSteps: number | undefined;
}

export const useChatSettings = (
  chatData: Serialized<Chat> | undefined,
  agentId: string,
) => {
  const [settings, setSettings] = useState<ChatSettings>({
    instructions: "",
    temperature: undefined,
    topP: undefined,
    topK: undefined,
    seed: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
    maxSteps: undefined,
  });

  // Initialize chat settings from existing chat data (only when no agent is
  // selected — an agent supplies its own settings). Re-syncs when either the
  // chat identity or the selected agent changes.
  //
  // Keyed on the Chat's id, never the row object: the row is replaced by every
  // poll flush while a run is live, and re-syncing on those discarded whatever
  // the user had typed into the settings dialog (issue #869).
  const initializeFromChat = () => {
    if (chatData && !agentId) {
      setSettings({
        instructions: chatData.instructions || "",
        temperature: chatData.temperature ?? undefined,
        topP: chatData.topP ?? undefined,
        topK: chatData.topK ?? undefined,
        seed: chatData.seed ?? undefined,
        presencePenalty: chatData.presencePenalty ?? undefined,
        frequencyPenalty: chatData.frequencyPenalty ?? undefined,
        maxSteps: chatData.maxSteps ?? undefined,
      });
    }
  };
  useResetOnChange(chatData?.id, initializeFromChat);
  useResetOnChange(agentId, initializeFromChat);

  // One object held in state, replaced only by a patch or a re-sync, so the
  // turn built from it — and the callbacks `ChatMessage` is memoised on —
  // survive a streamed token (#869).
  const updateSettings = useCallback(
    (patch: Partial<ChatSettings>) =>
      setSettings((prev) => ({ ...prev, ...patch })),
    [],
  );

  return { settings, updateSettings };
};
