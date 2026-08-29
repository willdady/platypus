"use client";

import { useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { XIcon } from "lucide-react";
import {
  PromptInputButton,
  PromptInputSubmit,
  type PromptInputMessage,
} from "./ai-elements/prompt-input";
import { Composer, type ModelSelection } from "./composer";

interface MessageEditorProps {
  /** The message's text as it stands, which the editor opens on. */
  initialText: string;
  /** The attachments it already carries, which the editor opens holding. */
  initialAttachments: FileUIPart[];
  modelSelection: ModelSelection;
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
  modelSelection,
  passthroughFileTypes,
  onSubmit,
  onCancel,
}: MessageEditorProps) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);

  // Opening an edit selects what is there, so retyping the message replaces it
  // rather than appending to it.
  useEffect(() => {
    textareaRef.current?.select();
  }, []);

  return (
    <Composer
      className="w-full"
      onSubmit={onSubmit}
      initialAttachments={initialAttachments}
      passthroughFileTypes={passthroughFileTypes}
      modelSelection={modelSelection}
      textarea={{
        ref: textareaRef,
        value: text,
        onChange: (e) => setText(e.target.value),
        // Escape belongs to the edit; claiming it here keeps the built-in
        // Enter-to-submit and Backspace-removes-attachment intact.
        onKeyDown: (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        },
        autoFocus: true,
      }}
      onTranscriptionChange={setText}
      submit={
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
      }
    />
  );
};
