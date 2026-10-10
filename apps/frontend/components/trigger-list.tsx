"use client";

import { useState } from "react";
import { TOKEN_STATUS_LABELS, TOKEN_STATUS_VARIANTS } from "@/lib/bearer-token";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { Button } from "@/components/ui/button";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError } from "@/components/list-state";
import {
  CardGridSkeleton,
  LoadingRegion,
  SkeletonLine,
} from "@/components/list-skeletons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { statusBadge } from "@/components/trigger-run-row";
import {
  Timer,
  Zap,
  Webhook,
  Play,
  EllipsisVertical,
  Pencil,
  Trash2,
  Pause,
  List,
  TriangleAlert,
} from "lucide-react";
import {
  type Trigger,
  type Agent,
  type CronTriggerConfig,
  type EventTriggerConfig,
  type InboundTriggerConfig,
  type TriggerType,
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

export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  cron: "Cron",
  event: "Event",
  inbound: "Inbound",
};

/** The trigger cards as they load; the workspace home draws them too. */
export const TriggerCardsSkeleton = ({ cards }: { cards?: number }) => (
  <CardGridSkeleton
    cards={cards}
    titleBadges={["w-12"]}
    extra={
      <>
        {/* The agent it runs, then its schedule or events. */}
        <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-24" />
        <SkeletonLine lineClassName="mt-1.5 h-4" className="h-3 w-48" />
      </>
    }
  />
);

/** An Inbound Trigger's line: what it takes, and how its token stands. */
const InboundSummary = ({ trigger }: { trigger: Trigger }) => {
  const config = trigger.config as InboundTriggerConfig;
  const inputs = config.inputs;
  const status = trigger.tokenStatus ?? "none";
  return (
    <span className="flex items-center gap-1 flex-wrap">
      <Webhook className="h-3 w-3" />
      Called from outside
      {inputs.length > 0 && (
        <>
          {" · Inputs:"}
          {inputs.map((input) => (
            <Badge
              key={input.name}
              variant="secondary"
              className="text-xs font-mono"
            >
              {input.name}
            </Badge>
          ))}
        </>
      )}
      {status === "expiring" && (
        <>
          {" · "}
          <span className="flex items-center gap-1 text-warning-foreground">
            <TriangleAlert className="h-3 w-3" />
            Token expiring soon
          </span>
        </>
      )}
      {(status === "none" || status === "expired") && (
        <>
          {" · Token:"}
          <Badge variant={TOKEN_STATUS_VARIANTS[status]} className="text-xs">
            {TOKEN_STATUS_LABELS[status]}
          </Badge>
        </>
      )}
    </span>
  );
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
  const [showFired, setShowFired] = useState(false);

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
  }>(showFired ? "triggers?includeFired=true" : "triggers", scope, {
    // Flipping Show fired changes the key; keep the list up while it loads.
    keepPreviousData: true,
  });

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

  if (isLoading && !triggersData) {
    return (
      <LoadingRegion label="Loading triggers">
        <TriggerCardsSkeleton />
      </LoadingRegion>
    );
  }

  if (error) {
    return <ListError error={error} subject="triggers" />;
  }

  // Shown even with nothing listed: fired One-offs may be all there is.
  const showFiredToggle = (
    <div className="flex items-center gap-2">
      <Switch
        id="show-fired-triggers"
        checked={showFired}
        onCheckedChange={setShowFired}
      />
      <Label htmlFor="show-fired-triggers" className="text-sm font-normal">
        Show fired
      </Label>
    </div>
  );

  if (!triggers.length) {
    return showFiredToggle;
  }

  return (
    <>
      {showFiredToggle}
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-2 lg:gap-4">
        {triggers.map((trigger) => (
          <li key={trigger.id}>
            <Item variant="outline" className="h-full cursor-pointer" asChild>
              <Link href={routes.triggers.detail(trigger.id)}>
                <ItemContent>
                  <div className="flex items-center gap-2">
                    <ItemTitle>{trigger.name}</ItemTitle>
                    <Badge variant="outline" className="text-xs">
                      {TRIGGER_TYPE_LABELS[trigger.type] ?? trigger.type}
                    </Badge>
                    {trigger.type === "cron" &&
                      (trigger.config as CronTriggerConfig).isOneOff && (
                        <Badge variant="outline" className="text-xs">
                          One-off
                        </Badge>
                      )}
                    {trigger.firedAt ? (
                      <>
                        <Badge variant="secondary" className="text-xs">
                          Fired
                        </Badge>
                        {trigger.lastRunStatus &&
                          statusBadge(trigger.lastRunStatus)}
                      </>
                    ) : (
                      !trigger.enabled && (
                        <Badge variant="secondary" className="text-xs">
                          Disabled
                        </Badge>
                      )
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
                    ) : trigger.type === "inbound" ? (
                      <InboundSummary trigger={trigger} />
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
                        aria-label={`Actions for ${trigger.name}`}
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
                      {/* A fired One-off is spent: it cannot be re-armed. */}
                      {!trigger.firedAt && (
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
                      )}
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
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? This will also delete all run history for this trigger. This action cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>
  );
};
