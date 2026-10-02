import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { FieldDescription } from "./ui/field";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";
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
import { CHAT_MAX_STEPS_ERROR, CHAT_SAMPLING_ERRORS } from "@/lib/chat-turn";

interface ChatSettingsDialogProps {
  instructions: string;
  onInstructionsChange: (value: string) => void;
  temperature: number | undefined;
  onTemperatureChange: (value: number | undefined) => void;
  seed: number | undefined;
  onSeedChange: (value: number | undefined) => void;
  topP: number | undefined;
  onTopPChange: (value: number | undefined) => void;
  topK: number | undefined;
  onTopKChange: (value: number | undefined) => void;
  presencePenalty: number | undefined;
  onPresencePenaltyChange: (value: number | undefined) => void;
  frequencyPenalty: number | undefined;
  onFrequencyPenaltyChange: (value: number | undefined) => void;
  maxSteps: number | undefined;
  onMaxStepsChange: (value: number | undefined) => void;
  onClose?: () => void;
}

export const ChatSettingsDialog = ({
  instructions,
  onInstructionsChange,
  temperature,
  onTemperatureChange,
  seed,
  onSeedChange,
  topP,
  onTopPChange,
  topK,
  onTopKChange,
  presencePenalty,
  onPresencePenaltyChange,
  frequencyPenalty,
  onFrequencyPenaltyChange,
  maxSteps,
  onMaxStepsChange,
  onClose,
}: ChatSettingsDialogProps) => {
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
    onMaxStepsChange(value === "" ? undefined : parseInt(value));
  };

  return (
    <DialogContent className="sm:max-w-[600px]" showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Chat Settings</DialogTitle>
        <DialogDescription>
          Configure advanced settings for this chat session.
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor="instructions">Instructions</Label>
          <Textarea
            id="instructions"
            placeholder="You are a helpful assistant..."
            value={instructions}
            onChange={(e) => onInstructionsChange(e.target.value)}
            rows={3}
          />
          <FieldDescription>
            How the assistant should behave in this chat. Platypus builds the
            full system prompt around it, adding workspace and user context,
            memories, and your Provider&apos;s security guardrails.
          </FieldDescription>
        </div>
        <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <div className="flex text-sm justify-between items-center">
              <span className="cursor-default">Advanced settings</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label="Toggle advanced settings"
                aria-expanded={isAdvancedOpen}
              >
                <ChevronsUpDown />
              </Button>
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="temperature">Temperature</Label>
                <Input
                  id="temperature"
                  aria-invalid={!!errors.temperature}
                  type="number"
                  min={TEMPERATURE_MIN}
                  step="0.1"
                  value={temperature ?? ""}
                  onChange={(e) =>
                    onTemperatureChange(
                      e.target.value === ""
                        ? undefined
                        : parseFloat(e.target.value),
                    )
                  }
                />
                {errors.temperature && (
                  <p className="text-destructive text-sm">
                    {errors.temperature}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="seed">Seed</Label>
                <Input
                  id="seed"
                  aria-invalid={!!errors.seed}
                  type="number"
                  value={seed ?? ""}
                  onChange={(e) =>
                    onSeedChange(
                      e.target.value === ""
                        ? undefined
                        : parseInt(e.target.value),
                    )
                  }
                />
                {errors.seed && (
                  <p className="text-destructive text-sm">{errors.seed}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="topP">Top-p</Label>
                <Input
                  id="topP"
                  aria-invalid={!!errors.topP}
                  type="number"
                  min={TOP_P_MIN}
                  max={TOP_P_MAX}
                  step="0.1"
                  value={topP ?? ""}
                  onChange={(e) =>
                    onTopPChange(
                      e.target.value === ""
                        ? undefined
                        : parseFloat(e.target.value),
                    )
                  }
                />
                {errors.topP && (
                  <p className="text-destructive text-sm">{errors.topP}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="topK">Top-k</Label>
                <Input
                  id="topK"
                  aria-invalid={!!errors.topK}
                  type="number"
                  min={TOP_K_MIN}
                  value={topK ?? ""}
                  onChange={(e) =>
                    onTopKChange(
                      e.target.value === ""
                        ? undefined
                        : parseInt(e.target.value),
                    )
                  }
                />
                {errors.topK && (
                  <p className="text-destructive text-sm">{errors.topK}</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="presencePenalty">Presence Penalty</Label>
                <Input
                  id="presencePenalty"
                  aria-invalid={!!errors.presencePenalty}
                  type="number"
                  min={PENALTY_MIN}
                  max={PENALTY_MAX}
                  step="0.1"
                  value={presencePenalty ?? ""}
                  onChange={(e) =>
                    onPresencePenaltyChange(
                      e.target.value === ""
                        ? undefined
                        : parseFloat(e.target.value),
                    )
                  }
                />
                {errors.presencePenalty && (
                  <p className="text-destructive text-sm">
                    {errors.presencePenalty}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="frequencyPenalty">Frequency Penalty</Label>
                <Input
                  id="frequencyPenalty"
                  aria-invalid={!!errors.frequencyPenalty}
                  type="number"
                  min={PENALTY_MIN}
                  max={PENALTY_MAX}
                  step="0.1"
                  value={frequencyPenalty ?? ""}
                  onChange={(e) =>
                    onFrequencyPenaltyChange(
                      e.target.value === ""
                        ? undefined
                        : parseFloat(e.target.value),
                    )
                  }
                />
                {errors.frequencyPenalty && (
                  <p className="text-destructive text-sm">
                    {errors.frequencyPenalty}
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor="maxSteps">Max steps</Label>
                <Input
                  id="maxSteps"
                  type="number"
                  min={CHAT_MAX_STEPS_MIN}
                  max={CHAT_MAX_STEPS_MAX}
                  step="1"
                  aria-invalid={maxStepsInvalid}
                  value={maxSteps ?? ""}
                  onChange={(e) => handleMaxStepsChange(e.target.value)}
                />
                {maxStepsInvalid && (
                  <p className="text-destructive text-sm">
                    {CHAT_MAX_STEPS_ERROR}
                  </p>
                )}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  );
};
