import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { FieldGroup } from "./ui/field";
import { FormTextareaField } from "./form-textarea-field";
import { FormTextField } from "./form-text-field";
import {
  CHAT_MAX_STEPS_MAX,
  CHAT_MAX_STEPS_MIN,
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
import { SamplingControls } from "./sampling-controls";
import { FormAdvancedSection } from "./form-advanced-section";
import type { ChatSettings } from "@/hooks/use-chat-settings";

type ChatSettingsDialogProps = {
  settings: ChatSettings;
  /** The selected model's Reasoning map, where its Provider honours one. */
  reasoning?: ReasoningMap;
  onChange: (patch: Partial<ChatSettings>) => void;
  onClose?: () => void;
};

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
    onChange({ maxSteps: value === "" ? undefined : parseInt(value, 10) });
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
        <FormAdvancedSection contentClassName="mt-4 grid gap-4">
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
          <SamplingControls
            value={settings}
            onChange={onChange}
            errors={errors}
            className="gap-4"
          />
          {/* Half-width like the sampling fields it follows, as when the two
              shared one grid. */}
          <FieldGroup className="grid grid-cols-2">
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
          </FieldGroup>
        </FormAdvancedSection>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  );
}
