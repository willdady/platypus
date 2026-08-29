"use client";

import { useState } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import type { FileUIPart, ChatStatus } from "ai";
import type { Agent, Provider } from "@platypus/schemas";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSpeechButton,
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

/**
 * What a composer needs to render the model picker. The pieces travel together
 * only to reach `ModelSelectorDialog`, so they are bundled rather than threaded
 * individually through every surface (issue #724).
 */
export interface ModelSelection {
  agents: Agent[];
  providers: Provider[];
  agentId: string;
  modelId: string;
  providerId: string;
  onModelChange: (value: string) => void;
  /** The resolved model's Output ceiling, for the picker's tooltip. */
  maxOutputTokens?: number;
}

/** The textarea's own controls, which are the one truly per-surface part. */
export interface ComposerTextareaProps {
  ref: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  status?: ChatStatus;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
}

interface ComposerProps {
  onSubmit: (message: PromptInputMessage) => void;
  passthroughFileTypes: string[];
  modelSelection: ModelSelection;
  textarea: ComposerTextareaProps;
  /** What dictation writes into the textarea. */
  onTranscriptionChange: (text: string) => void;
  className?: string;
  initialAttachments?: FileUIPart[];
  globalDrop?: boolean;
  /** Extra tools, rendered after the model picker (search toggle, dialogs). */
  tools?: ReactNode;
  /** Rendered between the tools and the submit control (the context meter). */
  footerContent?: ReactNode;
  /** The submit control, and anything beside it (the editor's Cancel). */
  submit: ReactNode;
}

/**
 * The stack every message-composing surface shares (issue #724): the
 * attachments strip, the compatibility notice, the textarea, the tool row —
 * action menu, dictation and model picker — and whatever submit control the
 * caller supplies. What differs between surfaces is passed in: the textarea's
 * own props, extra tools, the context meter and the submit control.
 */
export const Composer = ({
  onSubmit,
  passthroughFileTypes,
  modelSelection,
  textarea,
  onTranscriptionChange,
  className,
  initialAttachments,
  globalDrop,
  tools,
  footerContent,
  submit,
}: ComposerProps) => {
  // The picker's own open state: sharing it across surfaces would open both
  // dialogs at once.
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const { ref: textareaRef, ...textareaProps } = textarea;

  return (
    <PromptInput
      className={className}
      onSubmit={onSubmit}
      initialAttachments={initialAttachments}
      globalDrop={globalDrop}
      multiple
    >
      <PromptInputAttachments className="w-full">
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
      <FileCompatibilityWarning passthroughFileTypes={passthroughFileTypes} />
      <PromptInputBody>
        <PromptInputTextarea ref={textareaRef} {...textareaProps} />
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
                onTranscriptionChange={onTranscriptionChange}
              />
            </TooltipTrigger>
            <TooltipContent>Microphone</TooltipContent>
          </Tooltip>
          <ModelSelectorDialog
            agents={modelSelection.agents}
            providers={modelSelection.providers}
            agentId={modelSelection.agentId}
            modelId={modelSelection.modelId}
            providerId={modelSelection.providerId}
            isOpen={isModelSelectorOpen}
            onOpenChange={(open) => {
              setIsModelSelectorOpen(open);
              if (!open) {
                setTimeout(() => textareaRef.current?.focus(), 250);
              }
            }}
            onModelChange={modelSelection.onModelChange}
            maxOutputTokens={modelSelection.maxOutputTokens}
          />
          {tools}
        </PromptInputTools>
        {footerContent}
        {submit}
      </PromptInputFooter>
    </PromptInput>
  );
};
