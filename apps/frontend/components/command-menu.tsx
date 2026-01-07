"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  BotMessageSquare,
  Unplug,
  Wrench,
  Settings,
  ArrowLeftRight,
  Home,
  Info,
  Bot,
  Sparkles,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Agent } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";

interface CommandMenuProps {
  orgId: string;
  workspaceId: string;
}

export function CommandMenu({ orgId, workspaceId }: CommandMenuProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const backendUrl = useBackendUrl();
  const { user } = useAuth();

  // Fetch agents for the workspace
  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );

  const agents = agentsData?.results || [];

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((open) => !open);
      }
    };

    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  const runCommand = useCallback((command: () => unknown) => {
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
                router.push(`/${orgId}/workspace/${workspaceId}`),
              );
            }}
          >
            <Home />
            <span>Home</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push("/"));
            }}
          >
            <ArrowLeftRight />
            <span>Switch Org</span>
          </CommandItem>
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
                router.push(`/${orgId}/workspace/${workspaceId}/agents/create`),
              );
            }}
          >
            <Bot />
            <span>New Agent</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() =>
                router.push(`/${orgId}/workspace/${workspaceId}/skills/create`),
              );
            }}
          >
            <Sparkles />
            <span>New Skill</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push("/settings"));
            }}
          >
            <Settings />
            <span>Profile Settings</span>
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
            <span>Workspace Settings</span>
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
                router.push(
                  `/${orgId}/workspace/${workspaceId}/settings/about`,
                ),
              );
            }}
          >
            <Info />
            <span>About</span>
          </CommandItem>
        </CommandGroup>
        {agents.length > 0 && (
          <CommandGroup heading="Agents">
            {agents.map((agent) => (
              <CommandItem
                key={agent.id}
                className="cursor-pointer"
                onSelect={() => {
                  runCommand(() =>
                    router.push(
                      `/${orgId}/workspace/${workspaceId}/chat?agentId=${agent.id}`,
                    ),
                  );
                }}
              >
                <Bot />
                <span>{agent.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
