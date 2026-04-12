"use client";

import {
  Field,
  FieldLabel,
  FieldGroup,
  FieldSet,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ExpandableTextarea } from "@/components/expandable-textarea";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  type Trigger,
  type Agent,
  type CronTriggerConfig,
  type EventTriggerConfig,
  type KanbanBoard,
} from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Cron } from "croner";
import { format } from "date-fns";
import { toast } from "sonner";

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
  "card.deleted",
] as const;

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

const TriggerForm = ({
  orgId,
  workspaceId,
  triggerId,
}: {
  orgId: string;
  workspaceId: string;
  triggerId?: string;
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  const { data: agentsData, isLoading: agentsLoading } = useSWR<{
    results: Agent[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/agents`,
        )
      : null,
    fetcher,
  );
  const agents = agentsData?.results || [];

  const { data: boardsData } = useSWR<{
    results: KanbanBoard[];
  }>(
    backendUrl && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/boards`,
        )
      : null,
    fetcher,
  );
  const boards = boardsData?.results || [];

  const { data: trigger, isLoading: triggerLoading } = useSWR<Trigger>(
    triggerId && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        )
      : null,
    fetcher,
  );

  const [triggerType, setTriggerType] = useState<"cron" | "event">("cron");
  const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
  const [filterBoardId, setFilterBoardId] = useState<string>("");

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    agentId: "",
    instruction: "",
    cronExpression: "0 9 * * *",
    timezone: getBrowserTimezone(),
    isOneOff: false,
    enabled: true,
    maxChatsToKeep: 10,
    search: false,
  });

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

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const router = useRouter();

  useEffect(() => {
    if (trigger) {
      setTriggerType(trigger.type);
      setFormData({
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
        maxChatsToKeep: trigger.maxChatsToKeep,
        search: trigger.search ?? false,
      });

      if (trigger.type === "cron") {
        const cronConfig = trigger.config as CronTriggerConfig;
        const parsed = parseCronExpression(cronConfig.cronExpression);
        if (parsed) {
          setSimpleSchedule(parsed);
          setScheduleMode("simple");
        } else {
          setScheduleMode("advanced");
        }
      } else {
        const eventConfig = trigger.config as EventTriggerConfig;
        setSelectedEvents(eventConfig.events);
        setFilterBoardId(eventConfig.filters?.boardId || "");
      }
    } else if (agents.length > 0) {
      setFormData((prev) => ({
        ...prev,
        agentId: agents[0].id,
      }));
    }
  }, [trigger, agents]);

  const effectiveCronExpression = useMemo(() => {
    if (scheduleMode === "simple") {
      return buildCronExpression(
        simpleSchedule.frequency,
        simpleSchedule.minute,
        simpleSchedule.hour,
        simpleSchedule.dayOfWeek,
        simpleSchedule.dayOfMonth,
      );
    }
    return formData.cronExpression;
  }, [scheduleMode, simpleSchedule, formData.cronExpression]);

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
        nextRunPreview: next ? format(next, "PPp") : null,
      };
    } catch {
      return { isCronValid: false, nextRunPreview: null };
    }
  }, [triggerType, effectiveCronExpression, formData.timezone]);

  if (agentsLoading || (triggerId && triggerLoading)) {
    return null;
  }

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;

    if (validationErrors[id]) {
      setValidationErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[id];
        return newErrors;
      });
    }

    setFormData((prevData) => ({
      ...prevData,
      [id]: value,
    }));
  };

  const handleNumberChange = (id: string, value: string) => {
    setFormData((prevData) => ({
      ...prevData,
      [id]: value === "" ? undefined : parseInt(value),
    }));
  };

  const handleEventToggle = (event: string) => {
    setSelectedEvents((prev) => {
      const next = prev.includes(event)
        ? prev.filter((e) => e !== event)
        : [...prev, event];
      // Clear board filter if no card events remain
      if (!next.some((e) => e.startsWith("card."))) {
        setFilterBoardId("");
      }
      return next;
    });
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});
    try {
      const commonFields = {
        workspaceId,
        agentId: formData.agentId,
        name: formData.name,
        description: formData.description || undefined,
        instruction: formData.instruction,
        enabled: formData.enabled,
        maxChatsToKeep: formData.maxChatsToKeep,
        search: formData.search,
      };

      const payload =
        triggerType === "cron"
          ? {
              ...commonFields,
              type: "cron" as const,
              config: {
                cronExpression: effectiveCronExpression,
                timezone: formData.timezone,
                isOneOff: formData.isOneOff,
              },
            }
          : {
              ...commonFields,
              type: "event" as const,
              config: {
                events: selectedEvents,
                ...(filterBoardId
                  ? { filters: { boardId: filterBoardId } }
                  : {}),
              },
            };

      const url = triggerId
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${triggerId}`,
          )
        : joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/triggers`,
          );

      const method = triggerId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}`);
      } else {
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
        toast.error("Failed to save trigger");
      }
    } catch (error) {
      toast.error("Error saving trigger");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!triggerId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}`);
      } else {
        toast.error("Failed to delete trigger");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      }
    } catch (error) {
      toast.error("Error deleting trigger");
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
          {/* Trigger Type Selector */}
          <Field>
            <FieldLabel>Trigger Type</FieldLabel>
            <Select
              value={triggerType}
              onValueChange={(value) =>
                setTriggerType(value as "cron" | "event")
              }
              disabled={isSubmitting || !!triggerId}
            >
              <SelectTrigger disabled={isSubmitting || !!triggerId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cron">Cron</SelectItem>
                <SelectItem value="event">Event</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field data-invalid={!!validationErrors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              placeholder="Daily report generation"
              value={formData.name}
              onChange={handleChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.name}
              autoFocus
            />
            {validationErrors.name && (
              <FieldError>{validationErrors.name}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.description}>
            <FieldLabel htmlFor="description">Description</FieldLabel>
            <Input
              id="description"
              placeholder="Optional description..."
              value={formData.description}
              onChange={handleChange}
              disabled={isSubmitting}
              aria-invalid={!!validationErrors.description}
            />
            {validationErrors.description && (
              <FieldError>{validationErrors.description}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.agentId}>
            <FieldLabel>Agent</FieldLabel>
            <Select
              value={formData.agentId}
              onValueChange={(value) =>
                setFormData((prev) => ({ ...prev, agentId: value }))
              }
              disabled={isSubmitting}
            >
              <SelectTrigger disabled={isSubmitting}>
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {validationErrors.agentId && (
              <FieldError>{validationErrors.agentId}</FieldError>
            )}
          </Field>

          <Field data-invalid={!!validationErrors.instruction}>
            <ExpandableTextarea
              id="instruction"
              label="Instruction"
              placeholder={
                triggerType === "cron"
                  ? "Generate a daily report of..."
                  : "Process the incoming event and..."
              }
              value={formData.instruction}
              onChange={handleChange}
              disabled={isSubmitting}
              maxLength={10000}
              aria-invalid={!!validationErrors.instruction}
              error={validationErrors.instruction}
            />
            <FieldDescription>
              {triggerType === "cron"
                ? "The message sent to the agent each time this trigger runs"
                : "The message sent to the agent when the event occurs. Event data is included automatically."}
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
                    variant={scheduleMode === "simple" ? "default" : "outline"}
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
                                  <SelectItem key={opt.value} value={opt.value}>
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
                <Field data-invalid={!!validationErrors.cronExpression}>
                  <FieldLabel htmlFor="cronExpression">
                    Cron Expression
                  </FieldLabel>
                  <Input
                    id="cronExpression"
                    placeholder="0 9 * * *"
                    value={formData.cronExpression}
                    onChange={handleChange}
                    disabled={isSubmitting}
                    aria-invalid={!!validationErrors.cronExpression}
                    className={!isCronValid ? "border-destructive" : ""}
                  />
                  <FieldDescription>
                    Format: minute hour day-of-month month day-of-week. Example:
                    "0 9 * * *" runs daily at 9:00 AM.
                  </FieldDescription>
                  {validationErrors.cronExpression && (
                    <FieldError>{validationErrors.cronExpression}</FieldError>
                  )}
                  {!isCronValid && !validationErrors.cronExpression && (
                    <FieldError>Invalid cron expression</FieldError>
                  )}
                </Field>
              )}

              <Field data-invalid={!!validationErrors.timezone}>
                <FieldLabel>Timezone</FieldLabel>
                <Select
                  value={formData.timezone}
                  onValueChange={(value) =>
                    setFormData((prev) => ({ ...prev, timezone: value }))
                  }
                  disabled={isSubmitting}
                >
                  <SelectTrigger disabled={isSubmitting}>
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {TIMEZONES.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {validationErrors.timezone && (
                  <FieldError>{validationErrors.timezone}</FieldError>
                )}
              </Field>

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
                    <FieldLabel htmlFor={`event-${event}`}>{event}</FieldLabel>
                  </Field>
                ))}
              </div>
              {validationErrors.config && (
                <FieldError>{validationErrors.config}</FieldError>
              )}
            </Field>
          )}

          {/* Board filter for card events */}
          {triggerType === "event" &&
            selectedEvents.some((e) => e.startsWith("card.")) && (
              <Field>
                <FieldLabel>Filter by Board</FieldLabel>
                <Select
                  value={filterBoardId || "__all__"}
                  onValueChange={(value) =>
                    setFilterBoardId(value === "__all__" ? "" : value)
                  }
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
                <FieldDescription>
                  Optionally restrict card events to a specific board.
                </FieldDescription>
              </Field>
            )}

          <Field className="w-1/2">
            <FieldLabel htmlFor="maxChatsToKeep">Max Chats to Keep</FieldLabel>
            <Input
              id="maxChatsToKeep"
              type="number"
              min="1"
              max="1000"
              value={formData.maxChatsToKeep}
              onChange={(e) =>
                handleNumberChange("maxChatsToKeep", e.target.value)
              }
              disabled={isSubmitting}
            />
            <FieldDescription>
              Maximum number of chat records to keep (oldest will be deleted)
            </FieldDescription>
          </Field>

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
                  Model native web search (if supported by provider)
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
                  Trigger will run automatically
                </p>
              </div>
            </FieldLabel>
          </Field>
        </FieldGroup>
      </FieldSet>

      <div className="flex gap-2">
        <Button
          className="cursor-pointer"
          onClick={handleSubmit}
          disabled={
            isSubmitting ||
            Object.keys(validationErrors).length > 0 ||
            !isCronValid ||
            (triggerType === "event" && selectedEvents.length === 0)
          }
        >
          {triggerId ? "Update" : "Save"}
        </Button>

        {triggerId && (
          <Button
            className="cursor-pointer"
            variant="outline"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={isSubmitting}
          >
            <Trash2 /> Delete
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
        title="Delete Trigger"
        description="Are you sure you want to delete this trigger? This will also delete all chat history for this trigger. This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );
};

export { TriggerForm };
