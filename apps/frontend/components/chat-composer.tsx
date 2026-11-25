"use client";

import { useRef, useState, type ReactNode } from "react";
import type { ChatStatus } from "ai";
import type { PromptInputMessage } from "./ai-elements/prompt-input";
import { Composer, type ModelPickerConfig } from "./composer";
import { SlashCommandPicker } from "./slash-command-picker";
import { useSlashCommands } from "@/hooks/use-slash-commands";
import type { SlashCommand } from "@/lib/slash-commands";

type ChatComposerProps = {
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  canUploadToSandbox: boolean;
  commands: SlashCommand[];
  slashEnabled: boolean;
  placeholder: string;
  status: ChatStatus;
  disabled: boolean;
  className?: string;
  passthroughFileTypes: string[];
  modelSelection: ModelPickerConfig;
  tools?: ReactNode;
  footerContent?: ReactNode;
  submit: ReactNode;
};

// why: a keystroke re-renders only the composer, never the transcript
export function ChatComposer({
  onSubmit,
  canUploadToSandbox,
  commands,
  slashEnabled,
  placeholder,
  status,
  disabled,
  className,
  passthroughFileTypes,
  modelSelection,
  tools,
  footerContent,
  submit,
}: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState("");
  const slash = useSlashCommands({
    commands,
    enabled: slashEnabled,
    value: inputValue,
    onChange: setInputValue,
    textareaRef,
  });

  return (
    <>
      <SlashCommandPicker {...slash.picker} />
      <Composer
        onSubmit={async (message) => {
          await onSubmit(message);
          setInputValue("");
        }}
        canUploadToSandbox={canUploadToSandbox}
        globalDrop
        passthroughFileTypes={passthroughFileTypes}
        modelSelection={modelSelection}
        textarea={{
          ref: textareaRef,
          value: inputValue,
          onChange: (e) => setInputValue(e.target.value),
          // why: runs first so Enter accepts a highlighted command instead of sending
          onKeyDown: slash.onKeyDown,
          ...slash.combobox,
          className,
          placeholder,
          autoFocus: true,
          status,
          disabled,
        }}
        onTranscriptionChange={setInputValue}
        tools={tools}
        footerContent={footerContent}
        submit={submit}
      />
    </>
  );
}
