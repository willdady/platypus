import {
  CHAT_MAX_STEPS_MAX,
  CHAT_MAX_STEPS_MIN,
  PENALTY_MAX,
  PENALTY_MIN,
  TEMPERATURE_MIN,
  TOP_K_MIN,
  TOP_P_MAX,
  TOP_P_MIN,
  isValidChatMaxSteps,
  isValidChatSampling,
  isValidThinkingBudget,
  type ChatSamplingField,
} from "@platypus/schemas";
import type { ChatSettings } from "@/hooks/use-chat-settings";
import type { ModelSelection } from "@/hooks/use-model-selection";

export const CHAT_MAX_STEPS_ERROR = `Max steps must be a whole number between ${CHAT_MAX_STEPS_MIN} and ${CHAT_MAX_STEPS_MAX}.`;
export const CHAT_SAMPLING_ERRORS: Record<ChatSamplingField, string> = {
  temperature: `Temperature in Chat settings must be at least ${TEMPERATURE_MIN}.`,
  topP: `Top-p in Chat settings must be between ${TOP_P_MIN} and ${TOP_P_MAX}.`,
  topK: `Top-k in Chat settings must be a whole number of at least ${TOP_K_MIN}.`,
  seed: "Seed in Chat settings must be a whole number.",
  presencePenalty: `Presence Penalty in Chat settings must be between ${PENALTY_MIN} and ${PENALTY_MAX}.`,
  frequencyPenalty: `Frequency Penalty in Chat settings must be between ${PENALTY_MIN} and ${PENALTY_MAX}.`,
};
export const CHAT_THINKING_BUDGET_ERROR =
  "Thinking budget in Chat settings must be a whole number of at least 1.";

export const CHAT_SELECTION_ERROR =
  "Please select a model or agent to start the chat";

export type TurnRequest =
  { ok: true; body: Record<string, unknown> } | { ok: false; reason: string };

export function turnRequest({
  selection: { agentId, providerId, modelId },
  settings,
  search,
}: {
  selection: ModelSelection;
  settings: ChatSettings;
  search: boolean;
}): TurnRequest {
  if (agentId) return { ok: true, body: { agentId, search } };
  if (!providerId || !modelId) {
    return { ok: false, reason: CHAT_SELECTION_ERROR };
  }
  if (!isValidChatMaxSteps(settings.maxSteps)) {
    return { ok: false, reason: CHAT_MAX_STEPS_ERROR };
  }
  for (const field of Object.keys(
    CHAT_SAMPLING_ERRORS,
  ) as ChatSamplingField[]) {
    if (!isValidChatSampling(field, settings[field])) {
      return { ok: false, reason: CHAT_SAMPLING_ERRORS[field] };
    }
  }
  if (!isValidThinkingBudget(settings.thinkingBudget)) {
    return { ok: false, reason: CHAT_THINKING_BUDGET_ERROR };
  }
  return {
    ok: true,
    body: {
      providerId,
      modelId,
      instructions: settings.instructions || undefined,
      temperature: settings.temperature,
      topP: settings.topP,
      topK: settings.topK,
      seed: settings.seed,
      presencePenalty: settings.presencePenalty,
      frequencyPenalty: settings.frequencyPenalty,
      reasoningThinking: settings.reasoningThinking,
      reasoningEffort: settings.reasoningEffort,
      thinkingBudget: settings.thinkingBudget,
      maxSteps: settings.maxSteps,
      search,
    },
  };
}
