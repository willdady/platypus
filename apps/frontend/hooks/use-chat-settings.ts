import { useState } from "react";
import { Chat } from "@platypus/schemas";
import { useResetOnChange } from "@/hooks/use-reset-on-change";

export interface ChatSettings {
  systemPrompt: string;
  temperature: number | undefined;
  topP: number | undefined;
  topK: number | undefined;
  seed: number | undefined;
  presencePenalty: number | undefined;
  frequencyPenalty: number | undefined;
}

export const useChatSettings = (
  chatData: Chat | undefined,
  agentId: string,
) => {
  const [systemPrompt, setSystemPrompt] = useState("");
  const [temperature, setTemperature] = useState<number | undefined>();
  const [topP, setTopP] = useState<number | undefined>();
  const [topK, setTopK] = useState<number | undefined>();
  const [seed, setSeed] = useState<number | undefined>();
  const [presencePenalty, setPresencePenalty] = useState<number | undefined>();
  const [frequencyPenalty, setFrequencyPenalty] = useState<
    number | undefined
  >();

  // Initialize chat settings from existing chat data (only when no agent is
  // selected — an agent supplies its own settings). Re-syncs when either the
  // chat data or the selected agent changes.
  const initializeFromChat = () => {
    if (chatData && !agentId) {
      setSystemPrompt(chatData.systemPrompt || "");
      setTemperature(chatData.temperature ?? undefined);
      setTopP(chatData.topP ?? undefined);
      setTopK(chatData.topK ?? undefined);
      setSeed(chatData.seed ?? undefined);
      setPresencePenalty(chatData.presencePenalty ?? undefined);
      setFrequencyPenalty(chatData.frequencyPenalty ?? undefined);
    }
  };
  useResetOnChange(chatData, initializeFromChat);
  useResetOnChange(agentId, initializeFromChat);

  const settings: ChatSettings = {
    systemPrompt,
    temperature,
    topP,
    topK,
    seed,
    presencePenalty,
    frequencyPenalty,
  };

  const setters = {
    setSystemPrompt,
    setTemperature,
    setTopP,
    setTopK,
    setSeed,
    setPresencePenalty,
    setFrequencyPenalty,
  };

  return { settings, setters, ...setters };
};
