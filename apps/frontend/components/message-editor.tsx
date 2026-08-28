"use client";

import { useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import type { Agent, Provider } from "@platypus/schemas";
import { XIcon } from "lucide-react";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "./ai-elements/prompt-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileCompatibilityWarning } from "./file-compatibility-warning";
import { ModelSelectorDialog } from "./model-selector-dialog";

interface MessageEditorProps {
  /** The message's text as it stands, which the editor opens on. */
  initialText: string;
  /** The attachments it already carries, which the editor opens holding. */
  initialAttachments: FileUIPart[];
  agents: Agent[];
  providers: Provider[];
  agentId: string;
  modelId: string;
  providerId: string;
  onModelChange: (value: string) => void;
  /** The resolved model's Output ceiling, for the picker's tooltip. */
  maxOutputTokens?: number;
  /** What the resolved model reads natively, for the compatibility notice. */
  passthroughFileTypes: string[];
  onSubmit: (message: PromptInputMessage) => void;
  onCancel: () => void;
}

/**
 * Editing a message in place, through the same composer the message was
 * written with (issue #710).
 *
 * The rule for what this carries: anything that shapes the message's parts
 * stays — attachments, the compatibility notice, dictation — and anything that
 * configures the Chat or the run goes: no Agent info, no Chat settings, no
 * context meter, no search toggle.
 *
 * The model picker is the exception, and deliberately so. An edit resubmits
 * against live composer state, not against the model that produced the original
 * turn, so a user who changed the picker an hour ago and then edits an old
 * message gets a different model whether the picker is on screen or not.
 * Showing it is what makes that visible before saving — and re-running on
 * another model is a leading reason to edit at all on a multi-provider
 * platform. Picking one here changes the Chat's selection, exactly as picking
 * one in the composer does.
 *
 * `globalDrop` is deliberately absent: the composer claims the window-level
 * drop, and two inputs claiming it would both take the same file.
 */
export const MessageEditor = ({
  initialText,
  initialAttachments,
  agents,
  providers,
  agentId,
  modelId,
  providerId,
  onModelChange,
  maxOutputTokens,
  passthroughFileTypes,
  onSubmit,
  onCancel,
}: MessageEditorProps) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  // The edit surface's own picker state: sharing the composer's would open both
  // dialogs at once.
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);

  // Opening an edit selects what is there, so retyping the message replaces it
  // rather than appending to it.
  useEffect(() => {
    textareaRef.current?.select();
  }, []);

  return (
    <PromptInput
      className="w-full"
      onSubmit={onSubmit}
      initialAttachments={initialAttachments}
      multiple
    >
      <PromptInputAttachments className="w-full">
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
      <FileCompatibilityWarning passthroughFileTypes={passthroughFileTypes} />
      <PromptInputBody>
        <PromptInputTextarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          // Escape belongs to the edit; claiming it here keeps the built-in
          // Enter-to-submit and Backspace-removes-attachment intact.
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          autoFocus
        />
      </PromptInputBody>
      <PromptInputFooter className="flex-wrap">
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger className="cursor-pointer" />
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments className="cursor-pointer" />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <PromptInputSpeechButton
                aria-label="Microphone"
                className="cursor-pointer"
                textareaRef={textareaRef}
                onTranscriptionChange={setText}
              />
            </TooltipTrigger>
            <TooltipContent>Microphone</TooltipContent>
          </Tooltip>
          <ModelSelectorDialog
            agents={agents}
            providers={providers}
            agentId={agentId}
            modelId={modelId}
            providerId={providerId}
            isOpen={isModelSelectorOpen}
            onOpenChange={(open) => {
              setIsModelSelectorOpen(open);
              if (!open) {
                setTimeout(() => textareaRef.current?.focus(), 250);
              }
            }}
            onModelChange={onModelChange}
            maxOutputTokens={maxOutputTokens}
          />
        </PromptInputTools>
        <div className="flex items-center gap-1">
          <PromptInputButton
            aria-label="Cancel"
            className="cursor-pointer"
            onClick={onCancel}
          >
            <XIcon className="size-4" />
          </PromptInputButton>
          <PromptInputSubmit aria-label="Save" className="cursor-pointer" />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
};
