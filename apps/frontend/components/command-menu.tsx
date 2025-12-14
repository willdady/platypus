"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { BotMessageSquare, Bot, Unplug, Wrench, Settings } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface CommandMenuProps {
  orgId: string;
  workspaceId: string;
}

export function CommandMenu({ orgId, workspaceId }: CommandMenuProps) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const runCommand = React.useCallback((command: () => unknown) => {
    setOpen(false);
    command();
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() =>
                router.push(`/${orgId}/workspace/${workspaceId}/chat`),
              );
            }}
          >
            <BotMessageSquare />
            <span>New Chat</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() =>
                router.push(`/${orgId}/workspace/${workspaceId}/settings`),
              );
            }}
          >
            <Settings />
            <span>Settings</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() =>
                router.push(
                  `/${orgId}/workspace/${workspaceId}/settings/providers`,
                ),
              );
            }}
          >
            <Unplug />
            <span>Providers</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() =>
                router.push(`/${orgId}/workspace/${workspaceId}/settings/mcp`),
              );
            }}
          >
            <Wrench />
            <span>MCP</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() =>
                router.push(`/${orgId}/workspace/${workspaceId}/agents`),
              );
            }}
          >
            <Bot />
            <span>Agents</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
