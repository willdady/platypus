import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import { FormTextareaField } from "./form-textarea-field";
import { FormTextField } from "./form-text-field";
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
  type ReasoningMap,
} from "@platypus/schemas";
import {
  CHAT_MAX_STEPS_ERROR,
  CHAT_SAMPLING_ERRORS,
  CHAT_THINKING_BUDGET_ERROR,
} from "@/lib/chat-turn";
import { ReasoningControls } from "./reasoning-controls";
import type { ChatSettings } from "@/hooks/use-chat-settings";

type ChatSettingsDialogProps = {
  settings: ChatSettings;
  /** The selected model's Reasoning map, where its Provider honours one. */
  reasoning?: ReasoningMap;
  onChange: (patch: Partial<ChatSettings>) => void;
  onClose?: () => void;
};

/** A numeric setting is unset when its field is emptied, and parsed otherwise. */
function numberOrUndefined(
  value: string,
  parse: (value: string) => number,
): number | undefined {
  return value === "" ? undefined : parse(value);
}

export function ChatSettingsDialog({
  settings,
  reasoning,
  onChange,
  onClose,
}: ChatSettingsDialogProps) {
  const {
    instructions,
    temperature,
    seed,
    topP,
    topK,
    presencePenalty,
    frequencyPenalty,
    maxSteps,
  } = settings;
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

  // Derived from the value, not stored: a flag would reset when the dialog
  // remounts while an out-of-range value stayed in state. Judged by the schema
  // that will judge the request, not by a copy of its bounds.
  const maxStepsInvalid = !isValidChatMaxSteps(maxSteps);

  // Judged the same way, so a value saved before the bounds existed shows
  // here before it can refuse a turn (#1177).
  const samplingError = (
    field: ChatSamplingField,
    value: number | undefined,
  ) => (isValidChatSampling(field, value) ? null : CHAT_SAMPLING_ERRORS[field]);
  const errors = {
    temperature: samplingError("temperature", temperature),
    seed: samplingError("seed", seed),
    topP: samplingError("topP", topP),
    topK: samplingError("topK", topK),
    presencePenalty: samplingError("presencePenalty", presencePenalty),
    frequencyPenalty: samplingError("frequencyPenalty", frequencyPenalty),
  };

  const handleMaxStepsChange = (value: string) => {
    onChange({ maxSteps: numberOrUndefined(value, parseInt) });
  };

  return (
    <DialogContent
      className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]"
      showCloseButton={false}
    >
      <DialogHeader>
        <DialogTitle>Chat settings</DialogTitle>
        <DialogDescription>
          Configure advanced settings for this chat session.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <FormTextareaField
          label="Instructions"
          name="instructions"
          placeholder="You are a helpful assistant..."
          value={instructions}
          onChange={(value) => onChange({ instructions: value })}
          rows={3}
          textareaClassName="max-h-[15em] resize-none"
          description={
            <>
              How the assistant should behave in this chat. Platypus builds the
              full system prompt around it, adding workspace and user context,
              memories, and your Provider&apos;s security guardrails.
            </>
          }
        />
        <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <div className="flex text-sm justify-between items-center">
              <span className="cursor-default">Advanced settings</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Toggle advanced settings"
                aria-expanded={isAdvancedOpen}
              >
                <ChevronsUpDown />
              </Button>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4 grid gap-4">
            <ReasoningControls
              map={reasoning}
              value={settings}
              onChange={onChange}
              budgetError={
                isValidThinkingBudget(settings.thinkingBudget)
                  ? null
                  : CHAT_THINKING_BUDGET_ERROR
              }
            />
            <div className="grid grid-cols-2 gap-4">
              <FormTextField
                label="Temperature"
                name="temperature"
                type="number"
                min={TEMPERATURE_MIN}
                step="0.1"
                value={String(temperature ?? "")}
                onChange={(value) =>
                  onChange({
                    temperature: numberOrUndefined(value, parseFloat),
                  })
                }
                error={errors.temperature}
              />
              <FormTextField
                label="Seed"
                name="seed"
                type="number"
                value={String(seed ?? "")}
                onChange={(value) =>
                  onChange({
                    seed: numberOrUndefined(value, parseInt),
                  })
                }
                error={errors.seed}
              />
              <FormTextField
                label="Top-p"
                name="topP"
                type="number"
                min={TOP_P_MIN}
                max={TOP_P_MAX}
                step="0.1"
                value={String(topP ?? "")}
                onChange={(value) =>
                  onChange({
                    topP: numberOrUndefined(value, parseFloat),
                  })
                }
                error={errors.topP}
              />
              <FormTextField
                label="Top-k"
                name="topK"
                type="number"
                min={TOP_K_MIN}
                value={String(topK ?? "")}
                onChange={(value) =>
                  onChange({
                    topK: numberOrUndefined(value, parseInt),
                  })
                }
                error={errors.topK}
              />
              <FormTextField
                label="Presence Penalty"
                name="presencePenalty"
                type="number"
                min={PENALTY_MIN}
                max={PENALTY_MAX}
                step="0.1"
                value={String(presencePenalty ?? "")}
                onChange={(value) =>
                  onChange({
                    presencePenalty: numberOrUndefined(value, parseFloat),
                  })
                }
                error={errors.presencePenalty}
              />
              <FormTextField
                label="Frequency Penalty"
                name="frequencyPenalty"
                type="number"
                min={PENALTY_MIN}
                max={PENALTY_MAX}
                step="0.1"
                value={String(frequencyPenalty ?? "")}
                onChange={(value) =>
                  onChange({
                    frequencyPenalty: numberOrUndefined(value, parseFloat),
                  })
                }
                error={errors.frequencyPenalty}
              />
              <FormTextField
                label="Max steps"
                name="maxSteps"
                type="number"
                min={CHAT_MAX_STEPS_MIN}
                max={CHAT_MAX_STEPS_MAX}
                step="1"
                value={String(maxSteps ?? "")}
                onChange={handleMaxStepsChange}
                error={maxStepsInvalid ? CHAT_MAX_STEPS_ERROR : null}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  );
}
