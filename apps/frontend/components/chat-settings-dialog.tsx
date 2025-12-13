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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { ChevronsUpDown } from "lucide-react";
import { useState } from "react";

interface ChatSettingsDialogProps {
  systemPrompt: string;
  onSystemPromptChange: (value: string) => void;
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
  onClose?: () => void;
}

export const ChatSettingsDialog = ({
  systemPrompt,
  onSystemPromptChange,
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
  onClose,
}: ChatSettingsDialogProps) => {
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

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
          <Label htmlFor="systemPrompt">System Prompt</Label>
          <Textarea
            id="systemPrompt"
            placeholder="You are a helpful assistant..."
            value={systemPrompt}
            onChange={(e) => onSystemPromptChange(e.target.value)}
            rows={3}
          />
        </div>
        <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <div className="flex text-sm justify-between items-center">
              <span className="cursor-default">Advanced settings</span>
              <Button
                variant="ghost"
                size="icon"
                className="cursor-pointer size-8"
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
                  type="number"
                  min="0"
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
              </div>
              <div className="grid gap-2">
                <Label htmlFor="seed">Seed</Label>
                <Input
                  id="seed"
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
              </div>
              <div className="grid gap-2">
                <Label htmlFor="topP">Top-p</Label>
                <Input
                  id="topP"
                  type="number"
                  min="0"
                  max="1"
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
              </div>
              <div className="grid gap-2">
                <Label htmlFor="topK">Top-k</Label>
                <Input
                  id="topK"
                  type="number"
                  min="1"
                  value={topK ?? ""}
                  onChange={(e) =>
                    onTopKChange(
                      e.target.value === ""
                        ? undefined
                        : parseInt(e.target.value),
                    )
                  }
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="presencePenalty">Presence Penalty</Label>
                <Input
                  id="presencePenalty"
                  type="number"
                  min="-2"
                  max="2"
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
              </div>
              <div className="grid gap-2">
                <Label htmlFor="frequencyPenalty">Frequency Penalty</Label>
                <Input
                  id="frequencyPenalty"
                  type="number"
                  min="-2"
                  max="2"
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
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <DialogFooter>
        <Button className="cursor-pointer" onClick={onClose}>
          Done
        </Button>
      </DialogFooter>
    </DialogContent>
  );
};
