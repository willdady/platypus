"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import {
  completeSlashCommand,
  rankSlashCommands,
  slashQueryOf,
  type SlashCommand,
  type SlashCommandPickerProps,
} from "@/lib/slash-commands";

const LISTBOX_ID = "slash-command-picker";

const optionId = (name: string) => `slash-command-option-${name}`;

/** The ARIA the textarea wears while it is acting as a combobox. */
export type SlashComboboxProps = {
  role: "combobox";
  "aria-expanded": boolean;
  "aria-autocomplete": "list";
  "aria-controls": string | undefined;
  "aria-activedescendant": string | undefined;
};

export type UseSlashCommandsResult = {
  /**
   * Handed to the textarea's `onKeyDown`. `PromptInputTextarea` runs a caller's
   * handler FIRST and stands down on `defaultPrevented`, so preventing the
   * default here is what stops Enter submitting the message instead of
   * accepting the highlighted command (issue #710 relies on the same order).
   */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  combobox: SlashComboboxProps;
  picker: SlashCommandPickerProps;
};

/**
 * Drives the slash-command picker for one composer.
 *
 * The textarea stays a plain `<textarea>`: no chip, no inline colour, no
 * contenteditable. Completing a command only rewrites the value, so Enter-to-
 * submit, IME composition, paste, autosize and undo all keep working as they
 * did, and the token the user sees is the token that is sent.
 *
 * `enabled` is how "no Agent selected" becomes "no `/` handling at all" —
 * a Direct turn advertises no Skills, so the key is left to the textarea.
 */
export const useSlashCommands = ({
  commands,
  enabled,
  value,
  onChange,
  textareaRef,
}: {
  /** The Agent's assigned Skills, unfiltered: a user may invoke any of them. */
  commands: SlashCommand[];
  enabled: boolean;
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): UseSlashCommandsResult => {
  // The value Escape was pressed on. Editing the token reopens the picker,
  // which is what an editor does — Escape dismisses this token, not the feature.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  // The command the user has arrowed onto. Held by name rather than index so it
  // survives a re-rank, and falls back to the top match when the name drops out
  // of the list — no effect needed to keep an index in range.
  const [preferredName, setPreferredName] = useState<string | null>(null);

  const query = enabled ? slashQueryOf(value) : null;
  const open = query !== null && value !== dismissedFor;

  const items = useMemo(
    () => (query === null ? [] : rankSlashCommands(commands, query)),
    [commands, query],
  );

  const activeName =
    items.find((item) => item.name === preferredName)?.name ??
    items[0]?.name ??
    null;

  // The listbox exists only where there is something to list — an open picker
  // showing "no matching skill" renders a message, not a list. `aria-controls`
  // follows the element rather than the open state, so it never points at an
  // id that is not in the document.
  const hasListbox = open && items.length > 0;

  // Where the caret goes once the completed value has rendered. A controlled
  // textarea has the new value only after this commit, so the move waits for it
  // rather than racing the render.
  const pendingCaret = useRef<number | null>(null);
  useEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(at, at);
  }, [value, textareaRef]);

  const accept = (name: string) => {
    const completed = completeSlashCommand(name);
    pendingCaret.current = completed.length;
    setPreferredName(null);
    setDismissedFor(null);
    onChange(completed);
  };

  const move = (delta: number) => {
    const from = items.findIndex((item) => item.name === activeName);
    const next = (from + delta + items.length) % items.length;
    setPreferredName(items[next].name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open) return;

    if (event.key === "Escape") {
      event.preventDefault();
      setDismissedFor(value);
      return;
    }

    // Nothing highlighted — an empty state, or a name that matches no Skill.
    // Enter must still send the message and Tab must still move focus, because
    // an unresolved command is ordinary text, not a failure.
    if (!activeName) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Tab") {
      // Shift+Tab is still "go back a control".
      if (event.shiftKey) return;
      event.preventDefault();
      accept(activeName);
      return;
    }

    if (event.key === "Enter") {
      // Shift+Enter is still a newline, and a key committing an IME composition
      // is not a choice about the picker.
      if (event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      accept(activeName);
    }
  };

  return {
    onKeyDown,
    combobox: {
      role: "combobox",
      "aria-expanded": open,
      "aria-autocomplete": "list",
      "aria-controls": hasListbox ? LISTBOX_ID : undefined,
      "aria-activedescendant":
        open && activeName ? optionId(activeName) : undefined,
    },
    picker: {
      open,
      items,
      hasCommands: commands.length > 0,
      activeName,
      listboxId: LISTBOX_ID,
      optionId,
      onSelect: accept,
    },
  };
};
