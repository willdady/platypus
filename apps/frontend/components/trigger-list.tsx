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
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError, ListState } from "@/components/list-state";
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
import Link from "next/link";
import { useBackendUrl } from "@/components/auth-provider";
import { formatDateTime } from "@/lib/format-date";
import cronstrue from "cronstrue";
import { toast } from "sonner";
import { AgentAvatar } from "@/components/agent-avatar";
import { writeEntity, type Scope } from "@/lib/api-write";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { workspaceRoutes } from "@/lib/routes";

/**
 * Plain-English rendering of a cron expression, e.g. "At 09:00 AM, only on
 * Monday (UTC)". cronstrue throws on a malformed expression, so fall back to
 * showing it raw rather than blanking the row.
 */
const describeSchedule = (cronExpression: string, timezone: string): string => {
  try {
    return `${cronstrue.toString(cronExpression, { verbose: false })} (${timezone})`;
  } catch {
    return cronExpression;
  }
};

export const TriggerList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => {
  const backendUrl = useBackendUrl();
  const routes = workspaceRoutes(orgId, workspaceId);
  const [triggerToToggle, setTriggerToToggle] = useState<Trigger | null>(null);
  const [isToggling, setIsToggling] = useState(false);

  // Resolved once per render and reused for the list's reads and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = { orgId, workspaceId };

  const {
    data: triggersData,
    error,
    isLoading,
    mutate,
  } = useScopedSWR<{
    results: Trigger[];
  }>("triggers", scope);

  const { data: agentsData } = useScopedSWR<{ results: Agent[] }>(
    "agents",
    scope,
  );

  const agentsById = Object.fromEntries(
    (agentsData?.results || []).map((a) => [a.id, a]),
  );

  const triggers = [...(triggersData?.results || [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const deleteFlow = useDeleteFlow<Trigger>({
    mutate,
    delete: (trigger, url) =>
      writeEntity(url, "triggers", scope, { id: trigger.id }),
  });

  const handleToggleEnabled = async (trigger: Trigger) => {
    if (!backendUrl) return;

    setTriggerToToggle(trigger);
    setIsToggling(true);
    try {
      const outcome = await writeEntity(backendUrl, "triggers", scope, {
        id: trigger.id,
        data: { enabled: !trigger.enabled },
      });
      if (outcome.outcome === "success") {
        mutate();
      } else {
        toast.error(outcome.message);
      }
    } catch {
      toast.error("Failed to toggle trigger");
    } finally {
      setIsToggling(false);
      setTriggerToToggle(null);
    }
  };

  if (isLoading) {
    return <ListState variant="loading">Loading...</ListState>;
  }

  if (error) {
    return <ListError error={error} subject="triggers" />;
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
              <Link href={routes.triggers.detail(trigger.id)}>
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
                        <span
                          className="flex items-center gap-1"
                          title={
                            (trigger.config as CronTriggerConfig).cronExpression
                          }
                        >
                          <Timer className="h-3 w-3" />
                          {describeSchedule(
                            (trigger.config as CronTriggerConfig)
                              .cronExpression,
                            (trigger.config as CronTriggerConfig).timezone,
                          )}
                        </span>
                        {trigger.enabled && trigger.nextRunAt && (
                          <span className="flex items-center gap-1">
                            Next: {formatDateTime(trigger.nextRunAt)}
                          </span>
                        )}
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
                          href={routes.triggers.detail(trigger.id)}
                        >
                          <Pencil /> Edit
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link
                          className="cursor-pointer"
                          href={routes.triggerRuns.forTrigger(trigger.id)}
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
                        onSelect={() => deleteFlow.request(trigger)}
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

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete Trigger"
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? This will also delete all chat history for this trigger. This action cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>
  );
};
