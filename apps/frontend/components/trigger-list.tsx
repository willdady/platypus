"use client";

import { useState } from "react";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import {
  Timer,
  Zap,
  Play,
  EllipsisVertical,
  Pencil,
  Trash2,
  Pause,
  List,
} from "lucide-react";
import {
  type Trigger,
  type Agent,
  type CronTriggerConfig,
  type EventTriggerConfig,
} from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { describeSchedule } from "@/lib/cron-utils";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/agent-avatar";

export const TriggerList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [triggerToDelete, setTriggerToDelete] = useState<Trigger | null>(null);
  const [triggerToToggle, setTriggerToToggle] = useState<Trigger | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const {
    data: triggersData,
    isLoading,
    mutate,
  } = useSWR<{
    results: Trigger[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers`,
        )
      : null,
    fetcher,
  );

  const { data: agentsData } = useSWR<{ results: Agent[] }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );

  const agentsById = Object.fromEntries(
    (agentsData?.results || []).map((a) => [a.id, a]),
  );

  const triggers = [...(triggersData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const handleDeleteClick = (trigger: Trigger) => {
    setTriggerToDelete(trigger);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!triggerToDelete || !backendUrl) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${triggerToDelete.id}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        mutate();
        setDeleteDialogOpen(false);
        setTriggerToDelete(null);
      }
    } catch {
      toast.error("Failed to delete trigger");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleEnabled = async (trigger: Trigger) => {
    if (!backendUrl) return;

    setTriggerToToggle(trigger);
    setIsToggling(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${trigger.id}`,
        ),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            enabled: !trigger.enabled,
          }),
        },
      );

      if (response.ok) {
        mutate();
      }
    } catch {
      toast.error("Failed to toggle trigger");
    } finally {
      setIsToggling(false);
      setTriggerToToggle(null);
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!triggers.length) {
    return null;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
        {triggers.map((trigger) => (
          <li key={trigger.id}>
            <Item variant="outline" className="h-full cursor-pointer" asChild>
              <Link
                href={`/${orgId}/workspace/${workspaceId}/triggers/${trigger.id}`}
              >
                <ItemContent>
                  <div className="flex items-center gap-2">
                    <ItemTitle>{trigger.name}</ItemTitle>
                    <Badge variant="outline" className="text-xs">
                      {trigger.type === "cron" ? "Cron" : "Event"}
                    </Badge>
                    {trigger.type === "cron" &&
                      (trigger.config as CronTriggerConfig).isOneOff && (
                        <Badge variant="outline" className="text-xs">
                          One-off
                        </Badge>
                      )}
                    {!trigger.enabled && (
                      <Badge variant="secondary" className="text-xs">
                        Disabled
                      </Badge>
                    )}
                  </div>
                  {trigger.description && (
                    <ItemDescription className="text-xs">
                      {trigger.description}
                    </ItemDescription>
                  )}
                  {agentsById[trigger.agentId] && (
                    <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                      <AgentAvatar
                        agent={agentsById[trigger.agentId]}
                        className="size-4"
                      />
                      <span>{agentsById[trigger.agentId].name}</span>
                    </div>
                  )}
                  <div className="flex flex-col gap-1 mt-1.5 text-xs text-muted-foreground">
                    {trigger.type === "cron" ? (
                      <>
                        <span className="flex items-center gap-1">
                          <Timer className="h-3 w-3" />
                          {describeSchedule(
                            (trigger.config as CronTriggerConfig)
                              .cronExpression,
                            (trigger.config as CronTriggerConfig).timezone,
                          )}
                        </span>
                      </>
                    ) : (
                      <span className="flex items-center gap-1 flex-wrap">
                        <Zap className="h-3 w-3" />
                        {(trigger.config as EventTriggerConfig).events.map(
                          (event) => (
                            <Badge
                              key={event}
                              variant="secondary"
                              className="text-xs"
                            >
                              {event}
                            </Badge>
                          ),
                        )}
                      </span>
                    )}
                  </div>
                </ItemContent>
                <ItemActions className="gap-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        className="cursor-pointer text-muted-foreground"
                        variant="ghost"
                        size="icon"
                        onClick={(e) => e.preventDefault()}
                      >
                        <EllipsisVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent onClick={(e) => e.preventDefault()}>
                      <DropdownMenuItem asChild>
                        <Link
                          className="cursor-pointer"
                          href={`/${orgId}/workspace/${workspaceId}/triggers/${trigger.id}`}
                        >
                          <Pencil /> Edit
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link
                          className="cursor-pointer"
                          href={`/${orgId}/workspace/${workspaceId}/triggers/${trigger.id}/runs`}
                        >
                          <List /> View runs
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer"
                        onSelect={() => handleToggleEnabled(trigger)}
                        disabled={
                          isToggling && triggerToToggle?.id === trigger.id
                        }
                      >
                        {trigger.enabled ? (
                          <>
                            <Pause /> Disable
                          </>
                        ) : (
                          <>
                            <Play /> Enable
                          </>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="cursor-pointer text-destructive focus:text-destructive"
                        onSelect={() => handleDeleteClick(trigger)}
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ItemActions>
              </Link>
            </Item>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Trigger"
        description={`Are you sure you want to delete "${triggerToDelete?.name}"? This will also delete all chat history for this trigger. This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
        loading={isDeleting}
      />
    </>
  );
};
