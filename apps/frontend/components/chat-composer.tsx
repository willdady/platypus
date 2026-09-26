"use client";

import { useRef, useState, type ReactNode } from "react";
import type { ChatStatus } from "ai";
import type { PromptInputMessage } from "./ai-elements/prompt-input";
import { Composer, type ModelSelection } from "./composer";
import { SlashCommandPicker } from "./slash-command-picker";
import { useSlashCommands } from "@/hooks/use-slash-commands";
import type { SlashCommand } from "@/lib/slash-commands";

interface ChatComposerProps {
  /**
   * Runs on submit; the composer clears its own text afterwards, or keeps it
   * if the returned promise rejects.
   */
  onSubmit: (message: PromptInputMessage) => void | Promise<void>;
  /** Whether the action menu offers Upload to Sandbox. */
  canUploadToSandbox: boolean;
  /** The Agent's assigned Skills, unfiltered. Empty disables slash handling. */
  commands: SlashCommand[];
  /** Whether an Agent is selected — the gate on slash handling. */
  slashEnabled: boolean;
  placeholder: string;
  status: ChatStatus;
  disabled: boolean;
  className?: string;
  passthroughFileTypes: string[];
  modelSelection: ModelSelection;
  /** Extra tools, rendered after the model picker (search toggle, dialogs). */
  tools?: ReactNode;
  /** Rendered between the tools and the submit control (the context meter). */
  footerContent?: ReactNode;
  /** The submit control, and anything beside it. */
  submit: ReactNode;
}

/**
 * The Chat's composing surface, and the owner of everything that changes as
 * the user types: the textarea value and the slash-command picker's state.
 *
 * Both used to live in `Chat`, so every keystroke re-rendered the transcript
 * along with the composer (issue #869). The transcript and the composer now
 * have separate owners, and a keystroke re-renders only this subtree.
 */
export const ChatComposer = ({
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
}: ChatComposerProps) => {
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
          // Runs before `PromptInputTextarea`'s own Enter-to-submit branch,
          // which stands down on `defaultPrevented` — that ordering is what
          // lets Enter accept a highlighted command instead of sending the
          // message (issue #649).
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
};
