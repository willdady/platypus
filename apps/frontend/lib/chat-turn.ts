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
  type ChatSamplingField,
} from "@platypus/schemas";
import type { ChatSettings } from "@/hooks/use-chat-settings";
import type { ModelSelection } from "@/hooks/use-model-selection";

/**
 * Shown inline under the field and raised as a toast if a bad value somehow
 * reaches send. One string so the two paths cannot describe the bound
 * differently.
 */
export const CHAT_MAX_STEPS_ERROR = `Max steps must be a whole number between ${CHAT_MAX_STEPS_MIN} and ${CHAT_MAX_STEPS_MAX}.`;
/** Like {@link CHAT_MAX_STEPS_ERROR}, one string per sampling field (#1177). */
export const CHAT_SAMPLING_ERRORS: Record<ChatSamplingField, string> = {
  temperature: `Temperature in Chat Settings must be at least ${TEMPERATURE_MIN}.`,
  topP: `Top-p in Chat Settings must be between ${TOP_P_MIN} and ${TOP_P_MAX}.`,
  topK: `Top-k in Chat Settings must be a whole number of at least ${TOP_K_MIN}.`,
  seed: "Seed in Chat Settings must be a whole number.",
  presencePenalty: `Presence Penalty in Chat Settings must be between ${PENALTY_MIN} and ${PENALTY_MAX}.`,
  frequencyPenalty: `Frequency Penalty in Chat Settings must be between ${PENALTY_MIN} and ${PENALTY_MAX}.`,
};
export const CHAT_SELECTION_ERROR =
  "Please select a model or agent to start the chat";

/** The per-turn body a Chat turn carries, or why it may not start. */
export type TurnRequest =
  { ok: true; body: Record<string, unknown> } | { ok: false; reason: string };

/**
 * What a Chat turn sends, judged the same way whichever entry point starts it
 * (issue #971). An Agent turn carries the Agent and the search toggle; a
 * Direct turn carries the Provider, model and the Chat settings.
 *
 * The checks are a courtesy — `chatSubmitSchema` on the backend stays the
 * authority — but a refused request arrives as a failed turn after the
 * transcript has been cut, so it is worth never sending one.
 */
export const turnRequest = ({
  selection: { agentId, providerId, modelId },
  settings,
  search,
}: {
  selection: ModelSelection;
  settings: ChatSettings;
  search: boolean;
}): TurnRequest => {
  if (agentId) return { ok: true, body: { agentId, search } };
  if (!providerId || !modelId) {
    return { ok: false, reason: CHAT_SELECTION_ERROR };
  }
  // The dialog already marks an out-of-range ceiling invalid, but nothing
  // stopped it riding the turn as a 400 (#539). Only a Direct turn carries it.
  if (!isValidChatMaxSteps(settings.maxSteps)) {
    return { ok: false, reason: CHAT_MAX_STEPS_ERROR };
  }
  // A Chat saved before the bounds existed can still hold one out of range.
  for (const field of Object.keys(
    CHAT_SAMPLING_ERRORS,
  ) as ChatSamplingField[]) {
    if (!isValidChatSampling(field, settings[field])) {
      return { ok: false, reason: CHAT_SAMPLING_ERRORS[field] };
    }
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
      maxSteps: settings.maxSteps,
      search,
    },
  };
};
