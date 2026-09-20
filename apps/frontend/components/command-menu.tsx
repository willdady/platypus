"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
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
  KanbanSquare,
  Zap,
  Radio,
  LayoutDashboard,
  BookOpen,
  History,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Agent, KanbanBoard, Trigger } from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { userRoutes, workspaceRoutes } from "@/lib/routes";

interface CommandMenuProps {
  orgId: string;
  workspaceId: string;
}

export function CommandMenu({ orgId, workspaceId }: CommandMenuProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const routes = workspaceRoutes(orgId, workspaceId);
  const scope = { orgId, workspaceId };

  // Fetch agents for the workspace
  const { data: agentsData } = useScopedSWR<{ results: Agent[] }>(
    "agents",
    scope,
  );

  const agents = agentsData?.results || [];

  // Fetch boards for the workspace
  const { data: boardsData } = useScopedSWR<{ results: KanbanBoard[] }>(
    "boards",
    scope,
  );

  const boards = boardsData?.results || [];

  // Fetch triggers for the workspace
  const { data: triggersData } = useScopedSWR<{ results: Trigger[] }>(
    "triggers",
    scope,
  );

  const triggers = triggersData?.results || [];

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
              runCommand(() => router.push(routes.root));
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
            <span>Switch org</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.chat.root));
            }}
          >
            <BotMessageSquare />
            <span>New chat</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.agents.create));
            }}
          >
            <Bot />
            <span>New agent</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.skills.create));
            }}
          >
            <Sparkles />
            <span>New skill</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.boards.create));
            }}
          >
            <KanbanSquare />
            <span>New board</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.dashboards.create));
            }}
          >
            <LayoutDashboard />
            <span>New dashboard</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.triggers.create));
            }}
          >
            <Zap />
            <span>New trigger</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.triggerRuns.root));
            }}
          >
            <History />
            <span>Trigger runs</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.settings.createWebhook));
            }}
          >
            <Radio />
            <span>Add webhook</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(userRoutes.profile));
            }}
          >
            <Settings />
            <span>Profile settings</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.settings.root));
            }}
          >
            <Settings />
            <span>Workspace settings</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.settings.providers));
            }}
          >
            <Unplug />
            <span>Providers</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.settings.mcp));
            }}
          >
            <Wrench />
            <span>MCP</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() =>
                window.open(
                  "https://docs.platypus.chat",
                  "_blank",
                  "noopener,noreferrer",
                ),
              );
            }}
          >
            <BookOpen />
            <span>Docs</span>
          </CommandItem>
          <CommandItem
            className="cursor-pointer"
            onSelect={() => {
              runCommand(() => router.push(routes.settings.about));
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
                    router.push(`${routes.chat.root}?agentId=${agent.id}`),
                  );
                }}
              >
                <Bot />
                <span>{agent.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {boards.length > 0 && (
          <CommandGroup heading="Boards">
            {boards.map((board) => (
              <CommandItem
                key={board.id}
                className="cursor-pointer"
                onSelect={() => {
                  runCommand(() => router.push(routes.boards.detail(board.id)));
                }}
              >
                <KanbanSquare />
                <span>{board.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {triggers.length > 0 && (
          <CommandGroup heading="Triggers">
            {triggers.map((trigger) => (
              <CommandItem
                key={trigger.id}
                className="cursor-pointer"
                onSelect={() => {
                  runCommand(() =>
                    router.push(routes.triggers.detail(trigger.id)),
                  );
                }}
              >
                <Zap />
                <span>{trigger.name}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
