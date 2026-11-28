"use client";

import { useState } from "react";
import type {
  AriaAttributes,
  ChangeEvent,
  ComponentProps,
  KeyboardEvent,
  ReactNode,
  RefObject,
} from "react";
import type { FileUIPart, ChatStatus } from "ai";
import type { Agent, Provider } from "@platypus/schemas";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionAddSandboxUploads,
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
  usePromptInputAttachments,
  type PromptInputMessage,
} from "./ai-elements/prompt-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FileCompatibilityWarning } from "./file-compatibility-warning";
import { SelectionSubstitutedNotice } from "./selection-substituted-notice";
import type { SelectionSubstitution } from "@/lib/restore-selection";
import { ModelSelectorDialog } from "./model-selector-dialog";
import type { Serialized } from "@/lib/api-write";

// why: bundled to reach ModelSelectorDialog, not threaded through every surface
export type ModelPickerConfig = {
  agents: Serialized<Agent>[];
  providers: Serialized<Provider>[];
  agentId: string;
  modelId: string;
  providerId: string;
  isResolved: boolean;
  onModelChange: (value: string) => void;
  maxOutputTokens?: number;
  substitution?: SelectionSubstitution;
};

// why: ARIA travels as one bag, so the picker's set can't drift from a list here
export type ComposerTextareaProps = {
  ref: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  status?: ChatStatus;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  role?: string;
} & AriaAttributes;

type ComposerProps = {
  // why: a rejected promise keeps the attachments, so the user can retry
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  canUploadToSandbox?: boolean;
  passthroughFileTypes: string[];
  modelSelection: ModelPickerConfig;
  textarea: ComposerTextareaProps;
  onTranscriptionChange: (text: string) => void;
  className?: string;
  initialAttachments?: FileUIPart[];
  globalDrop?: boolean;
  tools?: ReactNode;
  footerContent?: ReactNode;
  submit: ReactNode;
};

export function Composer({
  onSubmit,
  canUploadToSandbox,
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
}: ComposerProps) {
  // why: one open state per surface, or both dialogs open at once
  const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
  const { ref: textareaRef, ...textareaProps } = textarea;

  return (
    <PromptInput
      className={className}
      onSubmit={onSubmit}
      initialAttachments={initialAttachments}
      globalDrop={globalDrop}
    >
      <PromptInputAttachments className="w-full">
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
      <SelectionSubstitutedNotice substitution={modelSelection.substitution} />
      <FileCompatibilityWarning passthroughFileTypes={passthroughFileTypes} />
      <PromptInputBody>
        <PromptInputTextarea
          // why: `textarea.ref` is the surface's own handle for this same node
          {...textareaProps}
          ref={textareaRef}
          // why: after the spread, so a surface can't take the name
          aria-label="Message"
        />
      </PromptInputBody>
      <PromptInputFooter className="flex-wrap">
        <PromptInputTools>
          <PromptInputActionMenu>
            <Tooltip delayDuration={1000}>
              <TooltipTrigger asChild>
                <PromptInputActionMenuTrigger aria-label="Add attachments" />
              </TooltipTrigger>
              <TooltipContent>Add attachments</TooltipContent>
            </Tooltip>
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments />
              {canUploadToSandbox && <PromptInputActionAddSandboxUploads />}
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <PromptInputSpeechButton
                aria-label="Microphone"
                textareaRef={textareaRef}
                onTranscriptionChange={onTranscriptionChange}
              />
            </TooltipTrigger>
            <TooltipContent>Microphone</TooltipContent>
          </Tooltip>
          <ComposerModelSelector
            agents={modelSelection.agents}
            providers={modelSelection.providers}
            agentId={modelSelection.agentId}
            modelId={modelSelection.modelId}
            providerId={modelSelection.providerId}
            isResolved={modelSelection.isResolved}
            isOpen={isModelSelectorOpen}
            onOpenChange={setIsModelSelectorOpen}
            // why: take the close focus, or mobile flaps the keyboard twice
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              textareaRef.current?.focus();
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
}

// why: lock the picker while a Sandbox upload is held; another Agent may not allow it
function ComposerModelSelector(
  props: Omit<ComponentProps<typeof ModelSelectorDialog>, "lockedReason">,
) {
  const { sandboxFiles } = usePromptInputAttachments();
  return (
    <ModelSelectorDialog
      {...props}
      lockedReason={
        sandboxFiles.length > 0
          ? "Remove Sandbox uploads to switch Agent"
          : undefined
      }
    />
  );
}
