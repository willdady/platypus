import { useMemo, useState } from "react";
import { Chat } from "@platypus/schemas";
import { useResetOnChange } from "@/hooks/use-reset-on-change";

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
  chatData: Chat | undefined,
  agentId: string,
) => {
  const [instructions, setInstructions] = useState("");
  const [temperature, setTemperature] = useState<number | undefined>();
  const [topP, setTopP] = useState<number | undefined>();
  const [topK, setTopK] = useState<number | undefined>();
  const [seed, setSeed] = useState<number | undefined>();
  const [presencePenalty, setPresencePenalty] = useState<number | undefined>();
  const [frequencyPenalty, setFrequencyPenalty] = useState<
    number | undefined
  >();
  const [maxSteps, setMaxSteps] = useState<number | undefined>();

  // Initialize chat settings from existing chat data (only when no agent is
  // selected — an agent supplies its own settings). Re-syncs when either the
  // chat identity or the selected agent changes.
  //
  // Keyed on the Chat's id, never the row object: the row is replaced by every
  // poll flush while a run is live, and re-syncing on those discarded whatever
  // the user had typed into the settings dialog (issue #869).
  const initializeFromChat = () => {
    if (chatData && !agentId) {
      setInstructions(chatData.instructions || "");
      setTemperature(chatData.temperature ?? undefined);
      setTopP(chatData.topP ?? undefined);
      setTopK(chatData.topK ?? undefined);
      setSeed(chatData.seed ?? undefined);
      setPresencePenalty(chatData.presencePenalty ?? undefined);
      setFrequencyPenalty(chatData.frequencyPenalty ?? undefined);
      setMaxSteps(chatData.maxSteps ?? undefined);
    }
  };
  useResetOnChange(chatData?.id, initializeFromChat);
  useResetOnChange(agentId, initializeFromChat);

  // One identity per actual value, so the turn built from it — and the
  // callbacks `ChatMessage` is memoised on — survive a streamed token (#869).
  const settings = useMemo<ChatSettings>(
    () => ({
      instructions,
      temperature,
      topP,
      topK,
      seed,
      presencePenalty,
      frequencyPenalty,
      maxSteps,
    }),
    [
      instructions,
      temperature,
      topP,
      topK,
      seed,
      presencePenalty,
      frequencyPenalty,
      maxSteps,
    ],
  );

  const setters = {
    setInstructions,
    setTemperature,
    setTopP,
    setTopK,
    setSeed,
    setPresencePenalty,
    setFrequencyPenalty,
    setMaxSteps,
  };

  return { settings, setters, ...setters };
};
