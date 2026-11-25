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

function optionId(name: string) {
  return `slash-command-option-${name}`;
}

export type SlashComboboxProps = {
  role: "combobox";
  "aria-expanded": boolean;
  "aria-autocomplete": "list";
  "aria-controls": string | undefined;
  "aria-activedescendant": string | undefined;
};

export type UseSlashCommandsResult = {
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  combobox: SlashComboboxProps;
  picker: SlashCommandPickerProps;
};

export function useSlashCommands({
  commands,
  enabled,
  value,
  onChange,
  textareaRef,
}: {
  commands: SlashCommand[];
  enabled: boolean;
  value: string;
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}): UseSlashCommandsResult {
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
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

  const hasListbox = open && items.length > 0;

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

    if (!activeName) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Tab") {
      if (event.shiftKey) return;
      event.preventDefault();
      accept(activeName);
      return;
    }

    if (event.key === "Enter") {
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
}
