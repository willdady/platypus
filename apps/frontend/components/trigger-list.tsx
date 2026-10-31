"use client";

import { useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CloneDialog } from "@/components/clone-dialog";
import { replaceSearchParam } from "@/lib/search-params";
import { TOKEN_STATUS_LABELS, TOKEN_STATUS_VARIANTS } from "@/lib/bearer-token";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ListState } from "@/components/list-state";
import { CardGridSkeleton, SkeletonLine } from "@/components/list-skeletons";
import { EntityCardList } from "@/components/entity-card-list";
import { RowActionsMenu } from "@/components/row-actions-menu";
import {
  ListFooter,
  ListPagination,
  pageOf,
} from "@/components/list-pagination";
import { Button } from "@/components/ui/button";
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
  History,
  Plus,
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

/** Triggers per page on the Workspace home. */
const TRIGGERS_PAGE_SIZE = 6;

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
          {/* The agent it runs, then its type's line and its last run. */}
          <SkeletonLine lineClassName="mt-1 h-4" className="h-3 w-24" />
          <div className="flex flex-col gap-1 mt-1.5">
            <SkeletonLine lineClassName="h-4" className="h-3 w-48" />
            <SkeletonLine lineClassName="h-4" className="h-3 w-28" />
          </div>
        </>
      }
    />
  );
}

/** One line of a Trigger card: one line tall, its text never wrapping. */
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

/** The dot between two facts sharing a card line. */
function LineSeparator() {
  return <span aria-hidden="true">·</span>;
}

/**
 * A Cron Trigger's schedule, with its cron expression on hover, then its
 * next run when it has one.
 */
function ScheduleLine({
  cronExpression,
  timezone,
  nextRunAt,
}: {
  cronExpression: string;
  timezone: string;
  nextRunAt?: string;
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
      {nextRunAt && (
        <>
          <LineSeparator />
          <TruncatedText text={`Next: ${nextRunAt}`} />
        </>
      )}
    </CardLine>
  );
}

/** An Inbound Trigger's line: what it takes, and how its token stands. */
function InboundLine({
  trigger,
}: {
  trigger: Extract<Serialized<Trigger>, { type: "inbound" }>;
}) {
  const inputs = trigger.config.inputs;
  const status = trigger.tokenStatus ?? "none";
  const hasInputs = inputs.length > 0;
  if (!hasInputs && status === "active") return null;
  return (
    <CardLine>
      {hasInputs && (
        <CountTooltip
          icon={<Webhook className="size-3" />}
          noun="input"
          names={inputs.map((input) => input.name)}
        />
      )}
      {hasInputs && status !== "active" && <LineSeparator />}
      {status === "expiring" && (
        <span className="flex min-w-0 items-center gap-1 text-warning-foreground">
          <TriangleAlert className="size-3 shrink-0" />
          <TruncatedText text="Token expiring soon" />
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
  const router = useRouter();
  const [triggerToClone, setTriggerToClone] =
    useState<Serialized<Trigger> | null>(null);

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

  // Only the fields a create takes: no run or token state rides along. The
  // clone starts disabled, and an Inbound clone asks for no token.
  const createClone = (
    original: Serialized<Trigger>,
    name: string,
    url: string,
  ) =>
    writeEntity<Trigger>(url, "triggers", scope, {
      data: {
        workspaceId,
        agentId: original.agentId,
        type: original.type,
        name,
        description: original.description ?? undefined,
        instruction: original.instruction,
        maxRunsToKeep: original.maxRunsToKeep,
        search: original.search,
        includeMemories: original.includeMemories,
        config: original.config,
        enabled: false,
        ...(original.type === "inbound" && { issueToken: false }),
      },
    });

  // The footer sits under every state, loading and failed included, as the
  // Create links did when the page drew them.
  const withFooter = (content: ReactNode, pagination?: ReactNode) => (
    <>
      {content}
      <ListFooter pagination={pagination}>
        <Button variant="outline" asChild>
          <Link href={routes.triggers.create}>
            <Plus /> Create trigger
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={routes.triggerRuns.root}>
            <History /> Trigger runs
          </Link>
        </Button>
      </ListFooter>
    </>
  );

  // A new filter starts on page 1.
  const setFilter = (key: string, value: string | null) => {
    replaceSearchParam(key, value);
    replaceSearchParam("triggersPage", null);
  };

  // Shown even with nothing listed: fired One-offs may be all there is.
  const controls =
    !error && allTriggers.length ? (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Select
          value={typeFilter}
          onValueChange={(value) =>
            setFilter("triggerType", value === ALL ? null : value)
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
              setFilter("triggerShowFired", checked ? "true" : null)
            }
            // Only a One-off fires, and a One-off is always Cron.
            disabled={typeFilter === "event" || typeFilter === "inbound"}
          />
          <Label htmlFor="show-fired-triggers" className="text-sm font-normal">
            Show fired
          </Label>
        </div>
      </div>
    ) : null;

  const shown =
    typeFilter === ALL
      ? triggers
      : triggers.filter((trigger) => trigger.type === typeFilter);

  const page = pageOf(
    searchParams.get("triggersPage"),
    shown,
    TRIGGERS_PAGE_SIZE,
  );

  // Nothing to list yet; fired One-offs hidden but reachable; or a type with
  // no Trigger of its own.
  const empty = !allTriggers.length ? (
    <ListState variant="empty">No triggers yet.</ListState>
  ) : !triggers.length ? null : (
    <ListState variant="empty">
      No {TRIGGER_TYPE_LABELS[typeFilter as TriggerType]} triggers to show.
    </ListState>
  );

  const renderBadges = (trigger: Serialized<Trigger>) => (
    <>
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
    </>
  );

  const renderMeta = (trigger: Serialized<Trigger>) => (
    <>
      <div className="flex h-4 min-w-0 items-center gap-1.5 mt-1 text-xs text-muted-foreground">
        {agentsById[trigger.agentId] && (
          <>
            <AgentAvatar
              agent={agentsById[trigger.agentId]}
              className="size-4 shrink-0"
            />
            <TruncatedText text={agentsById[trigger.agentId].name} />
          </>
        )}
      </div>
      {/* Two lines tall, the most any Trigger draws, so every card is one
          height and any spare space falls last. */}
      <div className="flex min-h-9 flex-col gap-1 mt-1.5 text-xs text-muted-foreground">
        {trigger.type === "cron" ? (
          <ScheduleLine
            cronExpression={trigger.config.cronExpression}
            timezone={trigger.config.timezone}
            nextRunAt={
              trigger.enabled && trigger.nextRunAt
                ? formatDateTime(trigger.nextRunAt)
                : undefined
            }
          />
        ) : trigger.type === "inbound" ? (
          <InboundLine trigger={trigger} />
        ) : (
          <CardLine>
            <CountTooltip
              icon={<Zap className="size-3" />}
              noun="event"
              names={trigger.config.events}
            />
          </CardLine>
        )}
        <CardLine>
          <span>Last run:</span>
          {trigger.lastRunStatus && trigger.lastRunStartedAt ? (
            <>
              <span title={formatDateTime(trigger.lastRunStartedAt)}>
                {formatRelativeTime(trigger.lastRunStartedAt)}
              </span>
              <StatusIcon status={trigger.lastRunStatus} />
            </>
          ) : (
            <span>Never</span>
          )}
        </CardLine>
      </div>
    </>
  );

  const renderMenu = (trigger: Serialized<Trigger>) => (
    <RowActionsMenu
      name={trigger.name}
      edit={{ href: routes.triggers.detail(trigger.id) }}
      clone={{ onSelect: () => setTriggerToClone(trigger) }}
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
  );

  return withFooter(
    <>
      {controls}
      <EntityCardList
        items={page.items}
        ghosts={page}
        isLoading={isLoading && !triggersData}
        error={error}
        subject="triggers"
        onRetry={() => void mutate()}
        skeleton={<TriggerCardsSkeleton />}
        empty={empty}
        // The card opens the Trigger's runs; Edit is in the menu.
        href={(trigger) => routes.triggerRuns.forTrigger(trigger.id)}
        badges={renderBadges}
        meta={renderMeta}
        actionsClassName="gap-1"
        menu={renderMenu}
      />

      {triggerToClone && (
        <CloneDialog
          noun="Trigger"
          original={triggerToClone.name}
          onClose={() => setTriggerToClone(null)}
          create={(name, url) => createClone(triggerToClone, name, url)}
          onCreated={(id) => {
            void mutate();
            router.push(routes.triggers.detail(id));
          }}
        />
      )}

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete Trigger"
        description={`Are you sure you want to delete "${deleteFlow.target?.name}"? This will also delete all run history for this trigger. This action cannot be undone.`}
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>,
    <ListPagination
      page={page}
      param="triggersPage"
      aria-label="Triggers pages"
    />,
  );
}
