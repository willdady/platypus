"use client";

import { useEffect, useRef, useState } from "react";
import type { FileUIPart } from "ai";
import { XIcon } from "lucide-react";
import {
  PromptInputButton,
  PromptInputSubmit,
  type PromptInputMessage,
} from "./ai-elements/prompt-input";
import { Composer, type ModelPickerConfig } from "./composer";

type MessageEditorProps = {
  initialText: string;
  initialAttachments: FileUIPart[];
  modelSelection: ModelPickerConfig;
  passthroughFileTypes: string[];
  onSubmit: (message: PromptInputMessage) => void;
  onCancel: () => void;
};

// why: the model picker stays — an edit re-runs on live composer state, not the old turn
export function MessageEditor({
  initialText,
  initialAttachments,
  modelSelection,
  passthroughFileTypes,
  onSubmit,
  onCancel,
}: MessageEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);

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
          <PromptInputButton aria-label="Cancel" onClick={onCancel}>
            <XIcon className="size-4" />
          </PromptInputButton>
          <PromptInputSubmit aria-label="Save" />
        </div>
      }
    />
  );
}
