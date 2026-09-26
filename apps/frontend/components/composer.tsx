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
  /** Whether the selection is settled; see `ModelSelectorDialog` (issue #799). */
  isResolved: boolean;
  onModelChange: (value: string) => void;
  /** The resolved model's Output ceiling, for the picker's tooltip. */
  maxOutputTokens?: number;
}

/**
 * The textarea's own controls, which are the one truly per-surface part.
 *
 * `AriaAttributes` and `role` are widened in rather than listed one by one: a
 * surface that turns the textarea into a combobox (the slash-command picker,
 * issue #649) supplies its ARIA as one bag, and that bag has to stay the
 * picker's business rather than becoming a list here that can drift from it.
 */
export interface ComposerTextareaProps extends AriaAttributes {
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
}

interface ComposerProps {
  /** A rejected promise keeps the attachments, so the user can retry. */
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  /**
   * Whether the action menu offers Upload to Sandbox: the Workspace has a
   * Sandbox that accepts uploads and the Agent has the `sandbox` Tool set.
   */
  canUploadToSandbox?: boolean;
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
              {canUploadToSandbox && (
                <PromptInputActionAddSandboxUploads className="cursor-pointer" />
              )}
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
          <ComposerModelSelector
            agents={modelSelection.agents}
            providers={modelSelection.providers}
            agentId={modelSelection.agentId}
            modelId={modelSelection.modelId}
            providerId={modelSelection.providerId}
            isResolved={modelSelection.isResolved}
            isOpen={isModelSelectorOpen}
            onOpenChange={setIsModelSelectorOpen}
            // Closing the picker returns to the textarea, so a model switch
            // doesn't interrupt typing. Radix would first hand focus back to
            // the trigger button; letting it do so and then moving focus on
            // again is two focus changes, which on mobile dismisses the
            // on-screen keyboard and reopens it a moment later (issue #749).
            // Taking over the close focus keeps it to a single move.
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
};

/**
 * The model picker, locked while the composer holds a Sandbox upload: the
 * upload was offered because this Agent has the `sandbox` Tool set, and
 * another selection may not.
 */
const ComposerModelSelector = (
  props: Omit<ComponentProps<typeof ModelSelectorDialog>, "lockedReason">,
) => {
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
};
