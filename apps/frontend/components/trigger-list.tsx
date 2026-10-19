"use client";

import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { replaceSearchParam } from "@/lib/search-params";
import { TOKEN_STATUS_LABELS, TOKEN_STATUS_VARIANTS } from "@/lib/bearer-token";
import {
  Item,
  ItemTitle,
  ItemActions,
  ItemDescription,
  ItemContent,
} from "@/components/ui/item";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListError, ListState } from "@/components/list-state";
import {
  CardGridSkeleton,
  LoadingRegion,
  SkeletonLine,
} from "@/components/list-skeletons";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { Badge } from "@/components/ui/badge";
import { DisabledBadge } from "@/components/disabled-badge";
import { useEnabledToggle } from "@/hooks/use-enabled-toggle";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusIcon } from "@/components/trigger-run-row";
import { CountTooltip } from "@/components/count-tooltip";
import {
  Timer,
  Zap,
  Webhook,
  TriangleAlert,
  CalendarClock,
  CircleCheck,
  type LucideIcon,
} from "lucide-react";
import {
  type Trigger,
  type Agent,
  type TriggerType,
  triggerTypeSchema,
} from "@platypus/schemas";
import Link from "next/link";
import { formatDateTime } from "@/lib/format-date";
import { formatRelativeTime } from "@/lib/relative-time";
import cronstrue from "cronstrue";
import { AgentAvatar } from "@/components/agent-avatar";
import { writeEntity, type Scope, type Serialized } from "@/lib/api-write";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { workspaceRoutes } from "@/lib/routes";

/**
 * Plain-English rendering of a cron expression, e.g. "At 09:00 AM, only on
 * Monday (UTC)". cronstrue throws on a malformed expression, so fall back to
 * showing it raw rather than blanking the row.
 */
function describeSchedule(cronExpression: string, timezone: string): string {
  try {
    return `${cronstrue.toString(cronExpression, { verbose: false })} (${timezone})`;
  } catch {
    return cronExpression;
  }
}

/** The value a Select carries for "no filter" — Radix rejects an empty one. */
const ALL = "all";

export const TRIGGER_TYPE_LABELS: Record<TriggerType, string> = {
  cron: "Cron",
  event: "Event",
  inbound: "Inbound",
};

const TRIGGER_TYPE_ICONS: Record<TriggerType, LucideIcon> = {
  cron: Timer,
  event: Zap,
  inbound: Webhook,
};

function TriggerTypeIcon({ type }: { type: TriggerType }) {
  const Icon = TRIGGER_TYPE_ICONS[type];
  return Icon ? <Icon /> : null;
}

/** The trigger cards as they load; the workspace home draws them too. */
export function TriggerCardsSkeleton({ cards }: { cards?: number }) {
  return (
    <CardGridSkeleton
      cards={cards}
      titleBadges={["w-12"]}
      extra={
        <>
          {/* The agent it runs, then its type's two lines and its last run. */}
          <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-24" />
          <div className="flex flex-col gap-1 mt-1.5">
            <SkeletonLine lineClassName="h-4" className="h-3 w-48" />
            <SkeletonLine lineClassName="h-4" className="h-3 w-32" />
            <SkeletonLine lineClassName="h-4" className="h-3 w-28" />
          </div>
        </>
      }
    />
  );
}

/**
 * One line of a Trigger card, kept one line tall even when empty, so every
 * card in the list is the height of its tallest kind of Trigger.
 */
function CardLine({ children }: { children?: ReactNode }) {
  return <div className="flex h-4 min-w-0 items-center gap-1">{children}</div>;
}

/** Text that ellipsizes on one line, with the full text on hover. */
function TruncatedText({
  text,
  title = text,
}: {
  text: string;
  title?: string;
}) {
  return (
    <span className="truncate" title={title}>
      {text}
    </span>
  );
}

/** A Cron Trigger's schedule, with its cron expression on hover. */
function ScheduleLine({
  cronExpression,
  timezone,
}: {
  cronExpression: string;
  timezone: string;
}) {
  const schedule = describeSchedule(cronExpression, timezone);
  return (
    <CardLine>
      <Timer className="size-3 shrink-0" />
      <TruncatedText
        text={schedule}
        // Unparseable, the schedule already is the expression.
        title={
          schedule === cronExpression
            ? schedule
            : `${schedule}\n${cronExpression}`
        }
      />
    </CardLine>
  );
}

/** An Inbound Trigger's lines: what it takes, and how its token stands. */
function InboundLines({
  trigger,
}: {
  trigger: Extract<Serialized<Trigger>, { type: "inbound" }>;
}) {
  const inputs = trigger.config.inputs;
  const status = trigger.tokenStatus ?? "none";
  return (
    <>
      <CardLine>
        {inputs.length > 0 && (
          <CountTooltip
            icon={<Webhook className="size-3" />}
            noun="input"
            names={inputs.map((input) => input.name)}
          />
        )}
      </CardLine>
      <CardLine>
        {status === "expiring" && (
          <span className="flex items-center gap-1 text-warning-foreground">
            <TriangleAlert className="size-3" />
            Token expiring soon
          </span>
        )}
        {(status === "none" || status === "expired") && (
          <>
            Token:
            {/* Line-tall, so the badge fits its one-line box. */}
            <Badge
              variant={TOKEN_STATUS_VARIANTS[status]}
              className="h-4 py-0 text-xs leading-none"
            >
              {TOKEN_STATUS_LABELS[status]}
            </Badge>
          </>
        )}
      </CardLine>
    </>
  );
}

export function TriggerList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const routes = workspaceRoutes(orgId, workspaceId);
  const searchParams = useSearchParams();

  // Both filters live in the URL, so they survive a refresh and Back. An
  // unknown type reads as no filter.
  const showFired = searchParams.get("triggerShowFired") === "true";
  const parsedType = triggerTypeSchema.safeParse(
    searchParams.get("triggerType"),
  );
  const typeFilter: TriggerType | typeof ALL = parsedType.success
    ? parsedType.data
    : ALL;

  // Resolved once per render and reused for the list's reads and every write
  // below, rather than re-deriving the Organization-vs-Workspace branch at
  // each call site.
  const scope: Scope = { orgId, workspaceId };

  const {
    data: triggersData,
    error,
    isLoading,
    mutate,
    results: triggerRows,
  } = useScopedList<Trigger>("triggers?includeFired=true", scope);

  const { results: agents } = useScopedList<Agent>("agents", scope);

  const agentsById = Object.fromEntries(agents.map((a) => [a.id, a]));

  const toggle = useEnabledToggle<Serialized<Trigger>>({
    entity: "triggers",
    scope,
    mutate,
  });

  // Fired One-offs are read too and hidden here, so the list knows whether
  // the Workspace has any triggers at all.
  const allTriggers = toggle.apply(triggerRows);
  const triggers = allTriggers
    .filter((trigger) => showFired || !trigger.firedAt)
    .sort((a, b) => a.name.localeCompare(b.name));

  const deleteFlow = useDeleteFlow<Serialized<Trigger>>({
    mutate,
    delete: (trigger, url) =>
      writeEntity(url, "triggers", scope, { id: trigger.id }),
  });

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

  // No controls with nothing to filter, as with the Skills section above it.
  if (!allTriggers.length) {
    return <ListState variant="empty">No triggers yet.</ListState>;
  }

  // Shown even with nothing listed: fired One-offs may be all there is.
  const controls = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Select
        value={typeFilter}
        onValueChange={(value) =>
          replaceSearchParam("triggerType", value === ALL ? null : value)
        }
      >
        <SelectTrigger className="w-36" aria-label="Filter by type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All types</SelectItem>
          {triggerTypeSchema.options.map((type) => (
            <SelectItem key={type} value={type}>
              {TRIGGER_TYPE_LABELS[type]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-2">
        <Switch
          id="show-fired-triggers"
          checked={showFired}
          onCheckedChange={(checked) =>
            replaceSearchParam("triggerShowFired", checked ? "true" : null)
          }
          // Only a One-off fires, and a One-off is always Cron.
          disabled={typeFilter === "event" || typeFilter === "inbound"}
        />
        <Label htmlFor="show-fired-triggers" className="text-sm font-normal">
          Show fired
        </Label>
      </div>
    </div>
  );

  if (!triggers.length) {
    return controls;
  }

  const shown =
    typeFilter === ALL
      ? triggers
      : triggers.filter((trigger) => trigger.type === typeFilter);

  if (!shown.length) {
    return (
      <>
        {controls}
        <ListState variant="empty">
          No {TRIGGER_TYPE_LABELS[typeFilter as TriggerType]} triggers to show.
        </ListState>
      </>
    );
  }

  return (
    <>
      {controls}
      <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2 lg:gap-4">
        {shown.map((trigger) => (
          <li key={trigger.id}>
            <Item variant="outline" className="h-full cursor-pointer" asChild>
              {/* The card opens the Trigger's runs; Edit is in the menu. */}
              <Link href={routes.triggerRuns.forTrigger(trigger.id)}>
                <ItemContent>
                  <div className="flex min-h-badge items-center gap-2">
                    <ItemTitle>{trigger.name}</ItemTitle>
                    <Badge variant="outline" className="text-xs">
                      <TriggerTypeIcon type={trigger.type} />
                      {TRIGGER_TYPE_LABELS[trigger.type] ?? trigger.type}
                    </Badge>
                    {trigger.type === "cron" && trigger.config.isOneOff && (
                      <Badge variant="outline" className="text-xs">
                        <CalendarClock />
                        One-off
                      </Badge>
                    )}
                    {trigger.firedAt ? (
                      <Badge variant="secondary" className="text-xs">
                        <CircleCheck />
                        Fired
                      </Badge>
                    ) : (
                      !trigger.enabled && <DisabledBadge />
                    )}
                  </div>
                  <ItemDescription
                    className="text-xs min-h-[2lh]"
                    title={trigger.description || undefined}
                  >
                    {trigger.description}
                  </ItemDescription>
                  <div className="flex h-4 min-w-0 items-center gap-1.5 mt-1 text-xs text-muted-foreground">
                    {agentsById[trigger.agentId] && (
                      <>
                        <AgentAvatar
                          agent={agentsById[trigger.agentId]}
                          className="size-4 shrink-0"
                        />
                        <TruncatedText
                          text={agentsById[trigger.agentId].name}
                        />
                      </>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 mt-1.5 text-xs text-muted-foreground">
                    {trigger.type === "cron" ? (
                      <>
                        <ScheduleLine
                          cronExpression={trigger.config.cronExpression}
                          timezone={trigger.config.timezone}
                        />
                        <CardLine>
                          {trigger.enabled && trigger.nextRunAt && (
                            <TruncatedText
                              text={`Next: ${formatDateTime(trigger.nextRunAt)}`}
                            />
                          )}
                        </CardLine>
                      </>
                    ) : trigger.type === "inbound" ? (
                      <InboundLines trigger={trigger} />
                    ) : (
                      <>
                        <CardLine>
                          <CountTooltip
                            icon={<Zap className="size-3" />}
                            noun="event"
                            names={trigger.config.events}
                          />
                        </CardLine>
                        <CardLine />
                      </>
                    )}
                    <CardLine>
                      {trigger.lastRunStatus && trigger.lastRunStartedAt && (
                        <>
                          <span>Last run:</span>
                          <span
                            title={formatDateTime(trigger.lastRunStartedAt)}
                          >
                            {formatRelativeTime(trigger.lastRunStartedAt)}
                          </span>
                          <StatusIcon status={trigger.lastRunStatus} />
                        </>
                      )}
                    </CardLine>
                  </div>
                </ItemContent>
                <ItemActions className="gap-1">
                  <RowActionsMenu
                    name={trigger.name}
                    edit={{ href: routes.triggers.detail(trigger.id) }}
                    toggle={
                      // A fired One-off is spent: it cannot be re-armed.
                      trigger.firedAt
                        ? undefined
                        : {
                            enabled: trigger.enabled,
                            onSelect: () => void toggle.toggle(trigger),
                            disabled: toggle.isToggling(trigger.id),
                          }
                    }
                    remove={{ onSelect: () => deleteFlow.request(trigger) }}
                  />
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
}
