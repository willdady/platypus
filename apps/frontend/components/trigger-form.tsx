"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { FormTextField } from "@/components/form-text-field";
import { FormSelectField } from "@/components/form-select-field";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { EntityDeleteDialog } from "@/components/entity-delete-dialog";
import { DetailFormState } from "@/components/detail-form-state";
import { FormFooterButtons } from "@/components/form-footer-buttons";
import {
  CollapsibleSkeleton,
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  SwitchRowSkeleton,
  TextareaSkeleton,
} from "@/components/form-skeleton";
import { Skeleton } from "@/components/ui/skeleton";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import { useState, useMemo } from "react";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useEntityDelete, useEntityForm } from "@/hooks/use-entity-form";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Plus, RefreshCw, ShieldOff, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  InboundTokenDialog,
  inboundEndpointUrl,
} from "@/components/inbound-token-dialog";
import { useBackendUrl } from "@/components/auth-provider";
import {
  type Trigger,
  type Agent,
  type CronTriggerConfig,
  type EventTriggerConfig,
  type InboundTriggerConfig,
  type Organization,
  type TriggerType,
  type KanbanBoard,
  type KanbanBoardState,
  type Workspace,
} from "@platypus/schemas";
import {
  DEFAULT_INBOUND_TRIGGER_TOKEN_EXPIRY_DAYS,
  INBOUND_TRIGGER_INPUT_DESCRIPTION_MAX_LENGTH,
  INBOUND_TRIGGER_INPUT_NAME_MAX_LENGTH,
  INBOUND_TRIGGER_MAX_INPUTS,
  INBOUND_TRIGGER_TOKEN_EXPIRY_DAYS,
  TRIGGER_INSTRUCTION_MAX_LENGTH,
  TRIGGER_MAX_RUNS_TO_KEEP_MAX,
  TRIGGER_MAX_RUNS_TO_KEEP_MIN,
} from "@platypus/schemas";
import { retractFieldError } from "@/lib/form-errors";
import { Cron } from "croner";
import { formatDateTime } from "@/lib/format-date";
import { toast } from "sonner";
import { workspaceRoutes } from "@/lib/routes";
import {
  organizationEntity,
  scopedUrl,
  workspaceEntity,
  writeAt,
} from "@/lib/api-write";
import { joinUrl } from "@/lib/utils";
import {
  INBOUND_TOKEN_STATUS_LABELS,
  INBOUND_TOKEN_STATUS_VARIANTS,
  inboundGateAdmits,
  inboundTokenStatus,
} from "@/lib/inbound-trigger";

const TIMEZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];

const getBrowserTimezone = (): string => {
  try {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TIMEZONES.includes(browserTz) ? browserTz : "UTC";
  } catch {
    return "UTC";
  }
};

type Frequency =
  | "every-5-minutes"
  | "every-10-minutes"
  | "every-15-minutes"
  | "every-30-minutes"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly";

const DAYS_OF_WEEK = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  value: i.toString(),
  label: i.toString().padStart(2, "0"),
}));

const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({
  value: i.toString(),
  label: i.toString().padStart(2, "0"),
}));

const DAY_OF_MONTH_OPTIONS = Array.from({ length: 31 }, (_, i) => ({
  value: (i + 1).toString(),
  label: (i + 1).toString(),
}));

const AVAILABLE_EVENTS = [
  "notification.created",
  "notification.updated",
  "notification.read",
  "notification.dismissed",
  "card.created",
  "card.updated",
  "card.moved",
  "card.deleted",
] as const;

// Mirrors the fields kanban.ts's changedCardFields diffs (updatedAt,
// lastEditedBy*, and position are bookkeeping and never appear there).
const CHANGED_FIELD_OPTIONS = [
  { value: "title", label: "Title" },
  { value: "body", label: "Body" },
  { value: "labelIds", label: "Labels" },
  { value: "assignees", label: "Assignees" },
  { value: "dueDate", label: "Due date" },
  { value: "priority", label: "Priority" },
] as const;

const INSTRUCTION_PLACEHOLDERS: Record<TriggerType, string> = {
  cron: "Generate a daily report of...",
  event: "Process the incoming event and...",
  inbound: "Work on the issue named in issueKey and...",
};

const INSTRUCTION_DESCRIPTIONS: Record<TriggerType, string> = {
  cron: "The message sent to the agent each time this trigger runs",
  event:
    "The message sent to the agent when the event occurs. Event data is included automatically.",
  inbound:
    "The message sent to the agent on each call. The call's inputs appear above it with their descriptions, so refer to them by name.",
};

const buildCronExpression = (
  frequency: Frequency,
  minute: string,
  hour: string,
  dayOfWeek: string,
  dayOfMonth: string,
): string => {
  switch (frequency) {
    case "every-5-minutes":
      return "*/5 * * * *";
    case "every-10-minutes":
      return "*/10 * * * *";
    case "every-15-minutes":
      return "*/15 * * * *";
    case "every-30-minutes":
      return "*/30 * * * *";
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    default:
      return "0 9 * * *";
  }
};

const parseCronExpression = (
  expression: string,
): {
  frequency: Frequency;
  minute: string;
  hour: string;
  dayOfWeek: string;
  dayOfMonth: string;
} | null => {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (
    minute === "*/5" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "every-5-minutes",
      minute: "0",
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    minute === "*/10" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "every-10-minutes",
      minute: "0",
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    minute === "*/15" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "every-15-minutes",
      minute: "0",
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    minute === "*/30" &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "every-30-minutes",
      minute: "0",
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(dayOfMonth) &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "monthly",
      minute,
      hour,
      dayOfWeek: "0",
      dayOfMonth,
    };
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    /^\d+$/.test(dayOfWeek)
  ) {
    return {
      frequency: "weekly",
      minute,
      hour,
      dayOfWeek,
      dayOfMonth: "1",
    };
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "daily",
      minute,
      hour,
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  if (
    /^\d+$/.test(minute) &&
    hour === "*" &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  ) {
    return {
      frequency: "hourly",
      minute,
      hour: "0",
      dayOfWeek: "0",
      dayOfMonth: "1",
    };
  }

  return null;
};

/** One declared input as the form edits it; saved as `inputs[]` (ADR-0030). */
type InboundInputDraft = {
  name: string;
  required: boolean;
  description: string;
};

/** Mirrors the backend's rule, so a bad name is caught before saving. */
const INPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * What stops the declared inputs from saving, if anything. The backend checks
 * the same rules; this only moves the message next to the rows.
 */
const inboundInputsProblem = (inputs: InboundInputDraft[]): string | null => {
  const names = inputs.map((input) => input.name.trim());
  if (names.some((name) => name === "")) return "Every input needs a name.";
  const bad = names.find((name) => !INPUT_NAME_PATTERN.test(name));
  if (bad !== undefined) {
    return `"${bad}" is not a valid input name. Start with a letter or underscore, then use only letters, digits and underscores.`;
  }
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) {
    return `"${duplicate}" is declared more than once.`;
  }
  return null;
};

/** What a save answers: a new Inbound Trigger's carries its token, once. */
type SavedTrigger = {
  id: string;
  token?: string;
  tokenExpiresAt?: string | null;
};

/** A token being shown in the one-time dialog, and where to go after. */
type ShownToken = {
  token: string;
  triggerId: string;
  expiresAt?: string | null;
  leaveOnClose: boolean;
};

// isOneOff, maxRunsToKeep, search, includeMemories,
// filterBoardId/filterColumnId, and enabled are deliberately excluded: this
// form has no field that retracts an error keyed to them.
const RETRACTABLE_FIELDS = [
  "name",
  "description",
  "agentId",
  "instruction",
  "cronExpression",
  "timezone",
  "config",
] as const;

type TriggerFormData = {
  name: string;
  description: string;
  agentId: string;
  instruction: string;
  cronExpression: string;
  timezone: string;
  isOneOff: boolean;
  enabled: boolean;
  maxRunsToKeep: number;
  search: boolean;
  includeMemories: boolean;
};

/** The cron layout, which a new trigger opens on and most saved ones use. */
const TriggerFormSkeleton = ({ editing }: { editing: boolean }) => (
  <div>
    <FormSkeletonSet>
      <FormSkeletonGroup>
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton />
        <TextareaSkeleton counter description={1} />
        {/* Schedule Mode's button pair */}
        <div className="flex w-full flex-col gap-3">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-9 w-44" />
        </div>
        <FieldSkeleton />
        <div className="flex gap-4">
          <FieldSkeleton className="flex-1" />
          <FieldSkeleton className="flex-1" />
        </div>
        <FieldSkeleton />
        <SwitchRowSkeleton />
        <FieldSkeleton className="w-1/2" description={1} />
        <SwitchRowSkeleton />
        <SwitchRowSkeleton />
        <CollapsibleSkeleton />
      </FormSkeletonGroup>
    </FormSkeletonSet>
    <FooterSkeleton buttons={editing ? 2 : 1} />
  </div>
);

const TriggerForm = ({
  orgId,
  workspaceId,
  triggerId,
}: {
  orgId: string;
  workspaceId: string;
  triggerId?: string;
}) => {
  const scope = { orgId, workspaceId };

  const { data: agentsData, isLoading: agentsLoading } = useScopedSWR<{
    results: Agent[];
  }>("agents", scope);
  const agents = useMemo(() => agentsData?.results || [], [agentsData]);

  const { data: boardsData, isLoading: boardsLoading } = useScopedSWR<{
    results: KanbanBoard[];
  }>("boards", scope);
  const boards = boardsData?.results || [];

  const [triggerType, setTriggerType] = useState<TriggerType>("cron");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [filterBoardId, setFilterBoardId] = useState<string>("");
  const [filterColumnId, setFilterColumnId] = useState<string>("");
  const [filterChangedFields, setFilterChangedFields] = useState<string[]>([]);
  const [inboundInputs, setInboundInputs] = useState<InboundInputDraft[]>([]);
  const [recordKey, setRecordKey] = useState<string>("");
  const [tokenExpiryDays, setTokenExpiryDays] = useState<number>(
    DEFAULT_INBOUND_TRIGGER_TOKEN_EXPIRY_DAYS,
  );
  const [shownToken, setShownToken] = useState<ShownToken | null>(null);
  const [isRegenerateDialogOpen, setIsRegenerateDialogOpen] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  // One reading of the clock per mount, for the token's expiry standing.
  const [now] = useState(() => Date.now());
  const backendUrl = useBackendUrl();

  // Whether the Organization gate lets this Workspace take calls, so an Owner
  // is told before they wire up a caller that would only ever get 404.
  const { data: organization } = useScopedSWR<Organization>(
    organizationEntity(orgId),
    {},
  );
  const { data: workspace } = useScopedSWR<Workspace>(
    workspaceEntity(workspaceId),
    { orgId },
  );

  const { data: boardStateData, isLoading: boardStateLoading } =
    useScopedSWR<KanbanBoardState>(
      `boards/${filterBoardId}/state`,
      filterBoardId ? scope : null,
    );
  const columns = boardStateData?.columns || [];

  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<"simple" | "advanced">(
    "simple",
  );
  const [simpleSchedule, setSimpleSchedule] = useState<{
    frequency: Frequency;
    minute: string;
    hour: string;
    dayOfWeek: string;
    dayOfMonth: string;
  }>({
    frequency: "daily",
    minute: "0",
    hour: "9",
    dayOfWeek: "1",
    dayOfMonth: "1",
  });

  const requiredInputNames = inboundInputs
    .filter((input) => input.required && input.name.trim())
    .map((input) => input.name.trim());
  // The record key names an input, so renaming, removing or un-requiring that
  // input unmarks it rather than saving a key that names nothing.
  const effectiveRecordKey = requiredInputNames.includes(recordKey)
    ? recordKey
    : "";

  const router = useRouter();

  const {
    record: trigger,
    mutateRecord,
    loadState,
    formData,
    setFormData,
    validationErrors,
    setValidationErrors,
    isSubmitting,
    canSubmit,
    handleChange,
    toFieldChange,
    setNumberField,
    setField,
    submit,
  } = useEntityForm<TriggerFormData, SavedTrigger, Trigger>({
    initialData: {
      name: "",
      description: "",
      agentId: "",
      instruction: "",
      cronExpression: "0 9 * * *",
      timezone: getBrowserTimezone(),
      isOneOff: false,
      enabled: true,
      maxRunsToKeep: 10,
      search: false,
      includeMemories: false,
    },
    entity: "triggers",
    scope: { orgId, workspaceId },
    id: triggerId,
    fromRecord: (trigger) => ({
      name: trigger.name,
      description: trigger.description || "",
      agentId: trigger.agentId,
      instruction: trigger.instruction,
      cronExpression:
        trigger.type === "cron"
          ? (trigger.config as CronTriggerConfig).cronExpression
          : "0 9 * * *",
      timezone:
        trigger.type === "cron"
          ? (trigger.config as CronTriggerConfig).timezone
          : getBrowserTimezone(),
      isOneOff:
        trigger.type === "cron"
          ? (trigger.config as CronTriggerConfig).isOneOff
          : false,
      enabled: trigger.enabled,
      maxRunsToKeep: trigger.maxRunsToKeep,
      search: trigger.search ?? false,
      includeMemories: trigger.includeMemories ?? false,
    }),
    onSeed: (trigger) => {
      setTriggerType(trigger.type);
      if (trigger.type === "cron") {
        const cronConfig = trigger.config as CronTriggerConfig;
        const parsed = parseCronExpression(cronConfig.cronExpression);
        if (parsed) {
          setSimpleSchedule(parsed);
          setScheduleMode("simple");
        } else {
          setScheduleMode("advanced");
        }
      } else if (trigger.type === "event") {
        const eventConfig = trigger.config as EventTriggerConfig;
        setSelectedEvents(eventConfig.events);
        setFilterBoardId(eventConfig.filters?.boardId || "");
        setFilterColumnId(eventConfig.filters?.columnId || "");
        setFilterChangedFields(eventConfig.filters?.changedFields || []);
      } else if (trigger.type === "inbound") {
        const inboundConfig = trigger.config as InboundTriggerConfig;
        setInboundInputs(
          inboundConfig.inputs.map((input) => ({
            name: input.name,
            required: input.required,
            description: input.description ?? "",
          })),
        );
        setRecordKey(inboundConfig.recordKey ?? "");
        setTokenExpiryDays(inboundConfig.tokenExpiryDays);
      }
    },
    retractableFields: RETRACTABLE_FIELDS,
    buildPayload: (data): unknown => {
      const commonFields = {
        workspaceId,
        agentId: data.agentId,
        name: data.name,
        description: data.description || undefined,
        instruction: data.instruction,
        enabled: data.enabled,
        maxRunsToKeep: data.maxRunsToKeep,
        search: data.search,
        includeMemories: data.includeMemories,
      };

      if (triggerType === "inbound") {
        return {
          ...commonFields,
          type: "inbound" as const,
          config: {
            inputs: inboundInputs.map((input) => ({
              name: input.name.trim(),
              required: input.required,
              ...(input.description.trim()
                ? { description: input.description.trim() }
                : {}),
            })),
            ...(effectiveRecordKey ? { recordKey: effectiveRecordKey } : {}),
            tokenExpiryDays,
          },
        };
      }

      return triggerType === "cron"
        ? {
            ...commonFields,
            type: "cron" as const,
            config: {
              cronExpression: effectiveCronExpression,
              timezone: data.timezone,
              isOneOff: data.isOneOff,
            },
          }
        : {
            ...commonFields,
            type: "event" as const,
            config: {
              events: selectedEvents,
              ...(filterBoardId || filterChangedFields.length > 0
                ? {
                    filters: {
                      ...(filterBoardId ? { boardId: filterBoardId } : {}),
                      ...(filterBoardId && filterColumnId
                        ? { columnId: filterColumnId }
                        : {}),
                      ...(filterChangedFields.length > 0
                        ? { changedFields: filterChangedFields }
                        : {}),
                    },
                  }
                : {}),
            },
          };
    },
    onSuccess: (saved) => {
      // A new Inbound Trigger's token is in this response and never again, so
      // it is shown before leaving the page.
      if (saved?.token) {
        setShownToken({
          token: saved.token,
          triggerId: saved.id,
          expiresAt: saved.tokenExpiresAt,
          leaveOnClose: true,
        });
        return;
      }
      router.push(workspaceRoutes(orgId, workspaceId).root);
    },
    failureMessage: "Error saving trigger",
  });

  const {
    isDeleteDialogOpen,
    setIsDeleteDialogOpen,
    isDeleting,
    openDeleteDialog,
    handleDelete,
  } = useEntityDelete({
    entity: "triggers",
    scope: { orgId, workspaceId },
    id: triggerId,
    onSuccess: () => router.push(workspaceRoutes(orgId, workspaceId).root),
    onError: (message, _outcome, { close }) => {
      toast.error(message);
      close();
    },
  });

  // When creating (no existing trigger), default the agent to the first
  // available one until the user picks another.
  useResetOnChange(agents, () => {
    if (!trigger && agents.length > 0) {
      setFormData((prev) => ({
        ...prev,
        agentId: agents[0].id,
      }));
    }
  });

  const effectiveCronExpression =
    scheduleMode === "simple"
      ? buildCronExpression(
          simpleSchedule.frequency,
          simpleSchedule.minute,
          simpleSchedule.hour,
          simpleSchedule.dayOfWeek,
          simpleSchedule.dayOfMonth,
        )
      : formData.cronExpression;

  const { isCronValid, nextRunPreview } = useMemo(() => {
    if (triggerType !== "cron")
      return { isCronValid: true, nextRunPreview: null };
    try {
      const cron = new Cron(effectiveCronExpression, {
        timezone: formData.timezone,
      });
      const next = cron.nextRun();
      return {
        isCronValid: true,
        nextRunPreview: next ? formatDateTime(next) : null,
      };
    } catch {
      return { isCronValid: false, nextRunPreview: null };
    }
  }, [triggerType, effectiveCronExpression, formData.timezone]);

  const inputsProblem =
    triggerType === "inbound" ? inboundInputsProblem(inboundInputs) : null;
  const inboundConfigErrors = Object.entries(validationErrors)
    .filter(([key]) => key === "config" || key.startsWith("config."))
    .map(([, message]) => message);

  const tokenStatus = trigger ? inboundTokenStatus(trigger, now) : "none";
  // Only once everything the answer depends on has loaded: under `selected`
  // that includes the Workspace's own flag, and a Workspace still loading (or
  // failed to load) is unknown, not disallowed.
  const gateClosed =
    organization !== undefined &&
    (organization.inboundTriggerGate !== "selected" ||
      workspace !== undefined) &&
    !inboundGateAdmits(
      organization.inboundTriggerGate,
      workspace?.inboundTriggersAllowed,
    );

  const inboundBlocked = triggerType === "inbound" && gateClosed;

  const updateInboundInputs = (
    update: (prev: InboundInputDraft[]) => InboundInputDraft[],
  ) => {
    setValidationErrors((prev) => retractFieldError(prev, "config"));
    setInboundInputs(update);
  };

  const updateInboundInput = (
    index: number,
    patch: Partial<InboundInputDraft>,
  ) =>
    updateInboundInputs((prev) =>
      prev.map((input, i) => (i === index ? { ...input, ...patch } : input)),
    );

  const handleRegenerateToken = async () => {
    if (!backendUrl || !triggerId) return;
    setIsRegenerating(true);
    const outcome = await writeAt<{ token: string; tokenExpiresAt: string }>(
      joinUrl(scopedUrl(backendUrl, "triggers", scope), `/${triggerId}/token`),
      { method: "POST" },
    );
    if (outcome.outcome === "success") {
      setShownToken({
        token: outcome.data.token,
        triggerId,
        expiresAt: outcome.data.tokenExpiresAt,
        leaveOnClose: false,
      });
      await mutateRecord();
    } else {
      toast.error(outcome.message);
    }
    setIsRegenerateDialogOpen(false);
    setIsRegenerating(false);
  };

  const closeTokenDialog = () => {
    const leave = shownToken?.leaveOnClose;
    setShownToken(null);
    if (leave) router.push(workspaceRoutes(orgId, workspaceId).root);
  };

  const handleEventToggle = (event: string) => {
    setValidationErrors((prev) => retractFieldError(prev, "config"));
    setSelectedEvents((prev) => {
      const next = prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event];
      // Clear board and column filters if no card events remain
      if (!next.some((e) => e.startsWith("card."))) {
        setFilterBoardId("");
        setFilterColumnId("");
      }
      // The changed-fields filter only makes sense against card.updated
      if (!next.includes("card.updated")) {
        setFilterChangedFields([]);
      }
      return next;
    });
  };

  const handleChangedFieldToggle = (field: string) => {
    setFilterChangedFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    );
  };

  const form = (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
          {/* Trigger Type Selector */}
          <Field>
            <FieldLabel>Trigger Type</FieldLabel>
            <Select
              value={triggerType}
              onValueChange={(value) => setTriggerType(value as TriggerType)}
              disabled={isSubmitting || !!triggerId}
            >
              <SelectTrigger disabled={isSubmitting || !!triggerId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">Cron</SelectItem>
                <SelectItem value="event">Event</SelectItem>
                <SelectItem value="inbound">Inbound</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {inboundBlocked && (
            <Alert>
              <ShieldOff />
              <AlertTitle>Inbound Triggers not allowed</AlertTitle>
              <AlertDescription>
                Your Organization doesn&apos;t allow Inbound Triggers in this
                Workspace.
              </AlertDescription>
            </Alert>
          )}

          {!inboundBlocked && (
            <>
              <FormTextField
                label="Name"
                name="name"
                placeholder="Daily report generation"
                value={formData.name}
                onChange={toFieldChange("name")}
                disabled={isSubmitting}
                error={validationErrors.name}
                autoFocus
              />

              <FormTextField
                label="Description"
                name="description"
                placeholder="Optional description..."
                value={formData.description}
                onChange={toFieldChange("description")}
                disabled={isSubmitting}
                error={validationErrors.description}
              />

              <FormSelectField
                label="Agent"
                name="agentId"
                value={formData.agentId}
                onValueChange={(value) => setField("agentId", value)}
                disabled={isSubmitting}
                placeholder="Select an agent"
                error={validationErrors.agentId}
              >
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    <AgentAvatar agent={agent} className="size-5" />
                    {agent.name}
                  </SelectItem>
                ))}
              </FormSelectField>

              <Field data-invalid={!!validationErrors.instruction}>
                <ExpandableTextarea
                  id="instruction"
                  label="Instruction"
                  placeholder={INSTRUCTION_PLACEHOLDERS[triggerType]}
                  value={formData.instruction}
                  onChange={handleChange}
                  disabled={isSubmitting}
                  maxLength={TRIGGER_INSTRUCTION_MAX_LENGTH}
                  aria-invalid={!!validationErrors.instruction}
                  error={validationErrors.instruction}
                />
                <FieldDescription>
                  {INSTRUCTION_DESCRIPTIONS[triggerType]}
                </FieldDescription>
              </Field>

              {/* Cron-specific fields */}
              {triggerType === "cron" && (
                <>
                  {/* Schedule Mode Toggle */}
                  <Field>
                    <FieldLabel>Schedule Mode</FieldLabel>
                    <ButtonGroup>
                      <Button
                        type="button"
                        variant={
                          scheduleMode === "simple" ? "default" : "outline"
                        }
                        onClick={() => setScheduleMode("simple")}
                        disabled={isSubmitting}
                        className="cursor-pointer"
                      >
                        Simple
                      </Button>
                      <Button
                        type="button"
                        variant={
                          scheduleMode === "advanced" ? "default" : "outline"
                        }
                        onClick={() => {
                          setScheduleMode("advanced");
                          setFormData((prev) => ({
                            ...prev,
                            cronExpression: effectiveCronExpression,
                          }));
                        }}
                        disabled={isSubmitting}
                        className="cursor-pointer"
                      >
                        Advanced
                      </Button>
                    </ButtonGroup>
                  </Field>

                  {/* Simple Mode Fields */}
                  {scheduleMode === "simple" && (
                    <>
                      <Field>
                        <FieldLabel>Frequency</FieldLabel>
                        <Select
                          value={simpleSchedule.frequency}
                          onValueChange={(value) =>
                            setSimpleSchedule((prev) => ({
                              ...prev,
                              frequency: value as Frequency,
                            }))
                          }
                          disabled={isSubmitting}
                        >
                          <SelectTrigger disabled={isSubmitting}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectItem value="every-5-minutes">
                                Every 5 minutes
                              </SelectItem>
                              <SelectItem value="every-10-minutes">
                                Every 10 minutes
                              </SelectItem>
                              <SelectItem value="every-15-minutes">
                                Every 15 minutes
                              </SelectItem>
                              <SelectItem value="every-30-minutes">
                                Every 30 minutes
                              </SelectItem>
                              <SelectItem value="hourly">Hourly</SelectItem>
                              <SelectItem value="daily">Daily</SelectItem>
                              <SelectItem value="weekly">Weekly</SelectItem>
                              <SelectItem value="monthly">Monthly</SelectItem>
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>

                      {simpleSchedule.frequency !== "every-5-minutes" &&
                        simpleSchedule.frequency !== "every-10-minutes" &&
                        simpleSchedule.frequency !== "every-15-minutes" &&
                        simpleSchedule.frequency !== "every-30-minutes" && (
                          <div className="flex gap-4">
                            {simpleSchedule.frequency !== "hourly" && (
                              <Field className="flex-1">
                                <FieldLabel>Hour</FieldLabel>
                                <Select
                                  value={simpleSchedule.hour}
                                  onValueChange={(value) =>
                                    setSimpleSchedule((prev) => ({
                                      ...prev,
                                      hour: value,
                                    }))
                                  }
                                  disabled={isSubmitting}
                                >
                                  <SelectTrigger disabled={isSubmitting}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectGroup>
                                      {HOUR_OPTIONS.map((opt) => (
                                        <SelectItem
                                          key={opt.value}
                                          value={opt.value}
                                        >
                                          {opt.label}
                                        </SelectItem>
                                      ))}
                                    </SelectGroup>
                                  </SelectContent>
                                </Select>
                              </Field>
                            )}

                            <Field className="flex-1">
                              <FieldLabel>Minute</FieldLabel>
                              <Select
                                value={simpleSchedule.minute}
                                onValueChange={(value) =>
                                  setSimpleSchedule((prev) => ({
                                    ...prev,
                                    minute: value,
                                  }))
                                }
                                disabled={isSubmitting}
                              >
                                <SelectTrigger disabled={isSubmitting}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectGroup>
                                    {MINUTE_OPTIONS.map((opt) => (
                                      <SelectItem
                                        key={opt.value}
                                        value={opt.value}
                                      >
                                        {opt.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </Field>
                          </div>
                        )}

                      {simpleSchedule.frequency === "weekly" && (
                        <Field>
                          <FieldLabel>Day of Week</FieldLabel>
                          <Select
                            value={simpleSchedule.dayOfWeek}
                            onValueChange={(value) =>
                              setSimpleSchedule((prev) => ({
                                ...prev,
                                dayOfWeek: value,
                              }))
                            }
                            disabled={isSubmitting}
                          >
                            <SelectTrigger disabled={isSubmitting}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {DAYS_OF_WEEK.map((day) => (
                                  <SelectItem key={day.value} value={day.value}>
                                    {day.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      )}

                      {simpleSchedule.frequency === "monthly" && (
                        <Field>
                          <FieldLabel>Day of Month</FieldLabel>
                          <Select
                            value={simpleSchedule.dayOfMonth}
                            onValueChange={(value) =>
                              setSimpleSchedule((prev) => ({
                                ...prev,
                                dayOfMonth: value,
                              }))
                            }
                            disabled={isSubmitting}
                          >
                            <SelectTrigger disabled={isSubmitting}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectGroup>
                                {DAY_OF_MONTH_OPTIONS.map((opt) => (
                                  <SelectItem key={opt.value} value={opt.value}>
                                    {opt.label}
                                  </SelectItem>
                                ))}
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </Field>
                      )}
                    </>
                  )}

                  {/* Advanced Mode */}
                  {scheduleMode === "advanced" && (
                    <FormTextField
                      label="Cron Expression"
                      name="cronExpression"
                      placeholder="0 9 * * *"
                      value={formData.cronExpression}
                      onChange={toFieldChange("cronExpression")}
                      disabled={isSubmitting}
                      inputClassName={!isCronValid ? "border-destructive" : ""}
                      error={
                        validationErrors.cronExpression ||
                        (!isCronValid ? "Invalid cron expression" : undefined)
                      }
                      description={
                        <>
                          Format: minute hour day-of-month month day-of-week.
                          Example: &quot;0 9 * * *&quot; runs daily at 9:00 AM.
                        </>
                      }
                    />
                  )}

                  <FormSelectField
                    label="Timezone"
                    name="timezone"
                    value={formData.timezone}
                    onValueChange={(value) => setField("timezone", value)}
                    disabled={isSubmitting}
                    placeholder="Select timezone"
                    error={validationErrors.timezone}
                  >
                    <SelectGroup>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </FormSelectField>

                  {nextRunPreview && isCronValid && (
                    <Field>
                      <FieldLabel>Next Run Preview</FieldLabel>
                      <div className="text-sm text-muted-foreground p-2 bg-muted rounded-md">
                        {nextRunPreview}
                      </div>
                    </Field>
                  )}

                  <Field orientation="horizontal">
                    <Switch
                      id="isOneOff"
                      className="cursor-pointer"
                      checked={formData.isOneOff}
                      onCheckedChange={(checked) =>
                        setFormData((prev) => ({ ...prev, isOneOff: checked }))
                      }
                      disabled={isSubmitting}
                    />
                    <FieldLabel htmlFor="isOneOff">
                      <div className="flex flex-col">
                        <p>One-off Trigger</p>
                        <p className="text-xs text-muted-foreground">
                          Run once and then disable
                        </p>
                      </div>
                    </FieldLabel>
                  </Field>
                </>
              )}

              {/* Event-specific fields */}
              {triggerType === "event" && (
                <Field>
                  <FieldLabel>Events</FieldLabel>
                  <FieldDescription>
                    Select the events that will trigger this agent.
                  </FieldDescription>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                    {AVAILABLE_EVENTS.map((event) => (
                      <Field key={event} orientation="horizontal">
                        <Switch
                          id={`event-${event}`}
                          className="cursor-pointer"
                          checked={selectedEvents.includes(event)}
                          onCheckedChange={() => handleEventToggle(event)}
                          disabled={isSubmitting}
                        />
                        <FieldLabel htmlFor={`event-${event}`}>
                          {event}
                        </FieldLabel>
                      </Field>
                    ))}
                  </div>
                  {validationErrors.config && (
                    <FieldError>{validationErrors.config}</FieldError>
                  )}
                </Field>
              )}

              {/* Board and column filters for card events */}
              {triggerType === "event" &&
                selectedEvents.some((e) => e.startsWith("card.")) && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field>
                      <FieldLabel>Only cards in this Board</FieldLabel>
                      <Select
                        value={filterBoardId || "__all__"}
                        onValueChange={(value) => {
                          setFilterBoardId(value === "__all__" ? "" : value);
                          setFilterColumnId("");
                        }}
                        disabled={isSubmitting}
                      >
                        <SelectTrigger disabled={isSubmitting}>
                          <SelectValue placeholder="All boards" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__all__">All boards</SelectItem>
                          {boards.map((board) => (
                            <SelectItem key={board.id} value={board.id}>
                              {board.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    {filterBoardId && (
                      <Field>
                        <FieldLabel>Only cards in this Column</FieldLabel>
                        <Select
                          value={filterColumnId || "__all__"}
                          onValueChange={(value) =>
                            setFilterColumnId(value === "__all__" ? "" : value)
                          }
                          disabled={isSubmitting}
                        >
                          <SelectTrigger disabled={isSubmitting}>
                            <SelectValue placeholder="All columns" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__all__">All columns</SelectItem>
                            {columns.map((col) => (
                              <SelectItem key={col.id} value={col.id}>
                                {col.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                  </div>
                )}

              {/* Changed-fields filter — only meaningful against card.updated */}
              {triggerType === "event" &&
                selectedEvents.includes("card.updated") && (
                  <Field>
                    <FieldLabel>
                      Only when these fields change (card.updated)
                    </FieldLabel>
                    <FieldDescription>
                      Only fire on a card update when one of these fields
                      actually changed. Leave all off to fire on any change.
                      Other selected events are unaffected — to fire on a column
                      change, select card.moved.
                    </FieldDescription>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2">
                      {CHANGED_FIELD_OPTIONS.map((field) => (
                        <Field key={field.value} orientation="horizontal">
                          <Switch
                            id={`changed-field-${field.value}`}
                            className="cursor-pointer"
                            checked={filterChangedFields.includes(field.value)}
                            onCheckedChange={() =>
                              handleChangedFieldToggle(field.value)
                            }
                            disabled={isSubmitting}
                          />
                          <FieldLabel htmlFor={`changed-field-${field.value}`}>
                            {field.label}
                          </FieldLabel>
                        </Field>
                      ))}
                    </div>
                  </Field>
                )}

              {/* Inbound-specific fields (ADR-0030) */}
              {triggerType === "inbound" && (
                <>
                  <Field data-invalid={inboundConfigErrors.length > 0}>
                    <FieldLabel>Inputs</FieldLabel>
                    <FieldDescription>
                      The values a caller sends as{" "}
                      <code>{`{ "inputs": { ... } }`}</code>. Every value is a
                      string. A call with a missing required input, an
                      undeclared one, or a value that isn&apos;t a string is
                      refused.
                    </FieldDescription>
                    <div className="flex flex-col gap-3 mt-2">
                      {inboundInputs.map((input, index) => (
                        <div
                          key={index}
                          className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-start"
                        >
                          <Input
                            aria-label={`Input ${index + 1} name`}
                            placeholder="issueKey"
                            className="font-mono sm:w-44"
                            value={input.name}
                            maxLength={INBOUND_TRIGGER_INPUT_NAME_MAX_LENGTH}
                            onChange={(e) =>
                              updateInboundInput(index, {
                                name: e.target.value,
                              })
                            }
                            disabled={isSubmitting}
                          />
                          <Input
                            aria-label={`Input ${index + 1} description`}
                            placeholder="What the agent should know about it"
                            className="flex-1"
                            value={input.description}
                            maxLength={
                              INBOUND_TRIGGER_INPUT_DESCRIPTION_MAX_LENGTH
                            }
                            onChange={(e) =>
                              updateInboundInput(index, {
                                description: e.target.value,
                              })
                            }
                            disabled={isSubmitting}
                          />
                          <div className="flex items-center justify-between gap-3 sm:h-9">
                            <Field orientation="horizontal" className="w-auto">
                              <Switch
                                id={`input-${index}-required`}
                                className="cursor-pointer"
                                checked={input.required}
                                onCheckedChange={(checked) =>
                                  updateInboundInput(index, {
                                    required: checked,
                                  })
                                }
                                disabled={isSubmitting}
                              />
                              <FieldLabel htmlFor={`input-${index}-required`}>
                                Required
                              </FieldLabel>
                            </Field>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="cursor-pointer shrink-0"
                              aria-label={`Remove input ${index + 1}`}
                              onClick={() =>
                                updateInboundInputs((prev) =>
                                  prev.filter((_, i) => i !== index),
                                )
                              }
                              disabled={isSubmitting}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                      <div>
                        <Button
                          type="button"
                          variant="outline"
                          className="cursor-pointer"
                          onClick={() =>
                            updateInboundInputs((prev) => [
                              ...prev,
                              { name: "", required: true, description: "" },
                            ])
                          }
                          disabled={
                            isSubmitting ||
                            inboundInputs.length >= INBOUND_TRIGGER_MAX_INPUTS
                          }
                        >
                          <Plus className="h-4 w-4" /> Add input
                        </Button>
                      </div>
                    </div>
                    {inputsProblem && <FieldError>{inputsProblem}</FieldError>}
                    {inboundConfigErrors.map((message) => (
                      <FieldError key={message}>{message}</FieldError>
                    ))}
                  </Field>

                  <Field>
                    <FieldLabel>Record key</FieldLabel>
                    <Select
                      value={effectiveRecordKey || "__none__"}
                      onValueChange={(value) =>
                        setRecordKey(value === "__none__" ? "" : value)
                      }
                      disabled={isSubmitting}
                    >
                      <SelectTrigger
                        aria-label="Record key"
                        disabled={isSubmitting}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {requiredInputNames.map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      The required input that says which record a call is about,
                      such as an issue key. Only one run per record is active at
                      a time, and the run-rate limit counts each record
                      separately. With none, the limit counts the whole trigger.
                      Marking one is the expected setup.
                    </FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel>Token lifetime</FieldLabel>
                    <Select
                      value={String(tokenExpiryDays)}
                      onValueChange={(value) =>
                        setTokenExpiryDays(Number(value))
                      }
                      disabled={isSubmitting}
                    >
                      <SelectTrigger
                        aria-label="Token lifetime"
                        disabled={isSubmitting}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INBOUND_TRIGGER_TOKEN_EXPIRY_DAYS.map((days) => (
                          <SelectItem key={days} value={String(days)}>
                            {days} days
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {triggerId
                        ? "Applies to the next token you issue. The current token keeps its expiry date."
                        : "How long the token works. You get a notification 30 and 7 days before it expires."}
                    </FieldDescription>
                  </Field>

                  {triggerId && trigger && (
                    <Field>
                      <FieldLabel>Token</FieldLabel>
                      <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <Badge
                            variant={INBOUND_TOKEN_STATUS_VARIANTS[tokenStatus]}
                          >
                            {INBOUND_TOKEN_STATUS_LABELS[tokenStatus]}
                          </Badge>
                          <Button
                            type="button"
                            variant="outline"
                            className="cursor-pointer"
                            onClick={() => setIsRegenerateDialogOpen(true)}
                            disabled={isSubmitting}
                          >
                            <RefreshCw className="h-4 w-4" />{" "}
                            {trigger.hasToken ? "Regenerate" : "Issue token"}
                          </Button>
                        </div>
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-muted-foreground">
                          <dt>Issued</dt>
                          <dd>
                            {trigger.tokenCreatedAt
                              ? formatDateTime(trigger.tokenCreatedAt)
                              : "—"}
                          </dd>
                          <dt>Expires</dt>
                          <dd>
                            {trigger.tokenExpiresAt
                              ? formatDateTime(trigger.tokenExpiresAt)
                              : "—"}
                          </dd>
                          <dt>Last used</dt>
                          <dd>
                            {trigger.lastUsedAt
                              ? formatDateTime(trigger.lastUsedAt)
                              : "Never"}
                          </dd>
                          <dt>Last rejected</dt>
                          <dd>
                            {trigger.lastRejectedAt
                              ? formatDateTime(trigger.lastRejectedAt)
                              : "Never"}
                          </dd>
                        </dl>
                        {backendUrl && (
                          <p className="break-all text-muted-foreground">
                            Endpoint:{" "}
                            <code>
                              {inboundEndpointUrl(backendUrl, triggerId)}
                            </code>
                          </p>
                        )}
                      </div>
                      <FieldDescription>
                        {trigger.hasToken
                          ? "The token was shown once, when it was issued. Regenerating stops the current one working straight away."
                          : "This trigger has no token, so every call is refused. An Org Admin may have revoked it. Issue a new one and update the system that calls it."}
                      </FieldDescription>
                    </Field>
                  )}
                </>
              )}

              <FormTextField
                className="w-1/2"
                label="Max Runs to Keep"
                name="maxRunsToKeep"
                type="number"
                min={TRIGGER_MAX_RUNS_TO_KEEP_MIN}
                max={TRIGGER_MAX_RUNS_TO_KEEP_MAX}
                value={String(formData.maxRunsToKeep)}
                onChange={(value) => setNumberField("maxRunsToKeep", value)}
                disabled={isSubmitting}
                description="Minimum number of recent run records to keep; older ones are pruned"
              />

              <Field orientation="horizontal">
                <Switch
                  id="search"
                  className="cursor-pointer"
                  checked={formData.search}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({ ...prev, search: checked }))
                  }
                  disabled={isSubmitting}
                />
                <FieldLabel htmlFor="search">
                  <div className="flex flex-col">
                    <p>Web Search</p>
                    <p className="text-xs text-muted-foreground">
                      Web search on the resolved provider — its built-in tool,
                      or a Web-search backend selected on it
                    </p>
                  </div>
                </FieldLabel>
              </Field>

              <Field orientation="horizontal">
                <Switch
                  id="enabled"
                  className="cursor-pointer"
                  checked={formData.enabled}
                  onCheckedChange={(checked) =>
                    setFormData((prev) => ({ ...prev, enabled: checked }))
                  }
                  disabled={isSubmitting}
                />
                <FieldLabel htmlFor="enabled">
                  <div className="flex flex-col">
                    <p>Enabled</p>
                    <p className="text-xs text-muted-foreground">
                      {triggerType === "inbound"
                        ? "Trigger accepts calls. A disabled one refuses them."
                        : "Trigger will run automatically"}
                    </p>
                  </div>
                </FieldLabel>
              </Field>

              <Collapsible
                open={isAdvancedOpen}
                onOpenChange={setIsAdvancedOpen}
              >
                <CollapsibleTrigger asChild>
                  <div className="flex text-sm justify-between items-center">
                    <span className="cursor-default">Advanced settings</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="cursor-pointer size-8"
                    >
                      <ChevronsUpDown />
                      <span className="sr-only">Toggle</span>
                    </Button>
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <Field orientation="horizontal" className="pt-2">
                    <Switch
                      id="includeMemories"
                      className="cursor-pointer"
                      checked={formData.includeMemories}
                      onCheckedChange={(checked) =>
                        setFormData((prev) => ({
                          ...prev,
                          includeMemories: checked,
                        }))
                      }
                      disabled={isSubmitting}
                    />
                    <FieldLabel htmlFor="includeMemories">
                      <div className="flex flex-col">
                        <p>Include Memories</p>
                        <p className="text-xs text-muted-foreground">
                          Add your recent memory summaries to this
                          trigger&apos;s system prompt. Off by default, so a run
                          isn&apos;t influenced by chat activity unrelated to
                          it.
                        </p>
                      </div>
                    </FieldLabel>
                  </Field>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </FieldGroup>
      </FieldSet>

      <FormFooterButtons
        submitText={triggerId ? "Update" : "Save"}
        onSubmit={() => void submit()}
        submitDisabled={
          isSubmitting ||
          !canSubmit ||
          !isCronValid ||
          (triggerType === "event" && selectedEvents.length === 0) ||
          inputsProblem !== null ||
          inboundBlocked
        }
        deleteVisible={!!triggerId}
        deleteDisabled={isSubmitting}
        onDelete={openDeleteDialog}
      />

      <EntityDeleteDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Trigger"
        description="Are you sure you want to delete this trigger? This will also delete all run history for this trigger. This action cannot be undone."
        onConfirm={handleDelete}
        loading={isDeleting}
      />

      <ConfirmDialog
        open={isRegenerateDialogOpen}
        onOpenChange={setIsRegenerateDialogOpen}
        title={trigger?.hasToken ? "Regenerate token" : "Issue token"}
        description={
          trigger?.hasToken
            ? "The current token stops working straight away. Update the system that calls this trigger with the new one."
            : "A new token is issued and shown once."
        }
        confirmLabel={trigger?.hasToken ? "Regenerate" : "Issue token"}
        onConfirm={() => void handleRegenerateToken()}
        loading={isRegenerating}
      />

      {shownToken && (
        <InboundTokenDialog
          open
          token={shownToken.token}
          endpointUrl={inboundEndpointUrl(
            backendUrl ?? "",
            shownToken.triggerId,
          )}
          expiresAt={shownToken.expiresAt}
          onClose={closeTokenDialog}
        />
      )}
    </div>
  );

  return (
    <DetailFormState
      {...loadState}
      // A saved board/column filter needs its lists to show a name rather
      // than a blank Select. Only a *seeded* column waits on the board's
      // columns: picking another board clears the column, so a later board
      // change never swaps the whole form back for the skeleton.
      isLoading={
        agentsLoading ||
        boardsLoading ||
        (!!filterColumnId && boardStateLoading) ||
        loadState.isLoading
      }
      subject="trigger"
      skeleton={<TriggerFormSkeleton editing={!!triggerId} />}
      backHref={workspaceRoutes(orgId, workspaceId).root}
      backLabel="Back to workspace"
    >
      {form}
    </DetailFormState>
  );
};

export { TriggerForm };
