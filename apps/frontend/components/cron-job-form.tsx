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
import { type CronJob, type Agent } from "@platypus/schemas";
import useSWR from "swr";
import { fetcher, parseValidationErrors, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { Cron } from "croner";
import { format } from "date-fns";

const TIMEZONES = Intl.supportedValuesOf("timeZone");

// Frequency options for Simple mode
type Frequency = "hourly" | "daily" | "weekly" | "monthly";

const DAYS_OF_WEEK = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

// Generate options for hours (0-23)
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  value: i.toString(),
  label: i.toString().padStart(2, "0"),
}));

// Generate options for minutes (0-59)
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => ({
  value: i.toString(),
  label: i.toString().padStart(2, "0"),
}));

// Generate options for day of month (1-31)
const DAY_OF_MONTH_OPTIONS = Array.from({ length: 31 }, (_, i) => ({
  value: (i + 1).toString(),
  label: (i + 1).toString(),
}));

/**
 * Builds a cron expression from simple mode parameters.
 * Cron format: minute hour day-of-month month day-of-week
 */
const buildCronExpression = (
  frequency: Frequency,
  minute: string,
  hour: string,
  dayOfWeek: string,
  dayOfMonth: string,
): string => {
  switch (frequency) {
    case "hourly":
      // Run at the specified minute of every hour
      return `${minute} * * * *`;
    case "daily":
      // Run at the specified time every day
      return `${minute} ${hour} * * *`;
    case "weekly":
      // Run at the specified time on the specified day of week
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      // Run at the specified time on the specified day of month
      return `${minute} ${hour} ${dayOfMonth} * *`;
    default:
      return "0 9 * * *";
  }
};

/**
 * Attempts to parse a cron expression into simple mode parameters.
 * Returns null if the expression doesn't match a simple pattern.
 */
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

  // Monthly: specific day of month
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

  // Weekly: specific day of week
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

  // Daily: every day at specific time
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

  // Hourly: every hour at specific minute
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

const CronJobForm = ({
  orgId,
  workspaceId,
  cronJobId,
}: {
  orgId: string;
  workspaceId: string;
  cronJobId?: string;
}) => {
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const { user } = useAuth();
  const backendUrl = useBackendUrl();

  // Fetch agents
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

  // Fetch existing cron job data if editing
  const { data: cronJob, isLoading: cronJobLoading } = useSWR<CronJob>(
    cronJobId && user
      ? joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs/${cronJobId}`,
        )
      : null,
    fetcher,
  );

  const [formData, setFormData] = useState({
    name: "",
    description: "",
    agentId: "",
    instruction: "",
    cronExpression: "0 9 * * *", // Default: Daily at 9:00 AM
    timezone: "UTC",
    isOneOff: false,
    enabled: true,
    maxChatsToKeep: 50,
  });

  // Simple mode state
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
    dayOfWeek: "1", // Monday
    dayOfMonth: "1",
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const router = useRouter();

  // Initialize form with existing cron job data when editing
  useEffect(() => {
    if (cronJob) {
      setFormData({
        name: cronJob.name,
        description: cronJob.description || "",
        agentId: cronJob.agentId,
        instruction: cronJob.instruction,
        cronExpression: cronJob.cronExpression,
        timezone: cronJob.timezone,
        isOneOff: cronJob.isOneOff,
        enabled: cronJob.enabled,
        maxChatsToKeep: cronJob.maxChatsToKeep,
      });

      // Try to parse existing cron expression for simple mode
      const parsed = parseCronExpression(cronJob.cronExpression);
      if (parsed) {
        setSimpleSchedule(parsed);
        setScheduleMode("simple");
      } else {
        setScheduleMode("advanced");
      }
    } else if (agents.length > 0) {
      // Initialize with first agent
      setFormData((prev) => ({
        ...prev,
        agentId: agents[0].id,
      }));
    }
  }, [cronJob, agents]);

  // Compute the effective cron expression based on mode
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

  // Compute next run preview
  const nextRunPreview = useMemo(() => {
    try {
      const cron = new Cron(effectiveCronExpression, {
        timezone: formData.timezone,
      });
      const next = cron.nextRun();
      if (next) {
        return format(next, "PPp");
      }
    } catch {
      return null;
    }
    return null;
  }, [effectiveCronExpression, formData.timezone]);

  const isCronValid = useMemo(() => {
    try {
      new Cron(effectiveCronExpression, { timezone: formData.timezone });
      return true;
    } catch {
      return false;
    }
  }, [effectiveCronExpression, formData.timezone]);

  if (agentsLoading || (cronJobId && cronJobLoading)) {
    return <div>Loading...</div>;
  }

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const { id, value } = e.target;

    // Clear validation error for this field
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

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setValidationErrors({});
    try {
      const payload = {
        workspaceId,
        agentId: formData.agentId,
        name: formData.name,
        description: formData.description || undefined,
        instruction: formData.instruction,
        cronExpression: effectiveCronExpression,
        timezone: formData.timezone,
        isOneOff: formData.isOneOff,
        enabled: formData.enabled,
        maxChatsToKeep: formData.maxChatsToKeep,
      };

      const url = cronJobId
        ? joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs/${cronJobId}`,
          )
        : joinUrl(
            backendUrl,
            `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs`,
          );

      const method = cronJobId ? "PUT" : "POST";

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        credentials: "include",
      });

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/cron-jobs`);
      } else {
        // Parse validation errors
        const errorData = await response.json();
        setValidationErrors(parseValidationErrors(errorData));
        console.error("Failed to save cron job");
      }
    } catch (error) {
      console.error("Error saving cron job:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!cronJobId) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs/${cronJobId}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        router.push(`/${orgId}/workspace/${workspaceId}/cron-jobs`);
      } else {
        console.error("Failed to delete cron job");
        setIsDeleting(false);
        setIsDeleteDialogOpen(false);
      }
    } catch (error) {
      console.error("Error deleting cron job:", error);
      setIsDeleting(false);
      setIsDeleteDialogOpen(false);
    }
  };

  return (
    <div>
      <FieldSet className="mb-6">
        <FieldGroup>
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
              placeholder="Generate a daily report of..."
              value={formData.instruction}
              onChange={handleChange}
              disabled={isSubmitting}
              maxLength={10000}
              aria-invalid={!!validationErrors.instruction}
              error={validationErrors.instruction}
            />
            <FieldDescription>
              The message that will be sent to the agent each time this schedule
              runs
            </FieldDescription>
          </Field>

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
                variant={scheduleMode === "advanced" ? "default" : "outline"}
                onClick={() => {
                  setScheduleMode("advanced");
                  // Sync the current simple expression to advanced mode
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
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>

              <div className="flex gap-4">
                {/* Hour selector (not shown for hourly) */}
                {simpleSchedule.frequency !== "hourly" && (
                  <Field className="flex-1">
                    <FieldLabel>Hour</FieldLabel>
                    <Select
                      value={simpleSchedule.hour}
                      onValueChange={(value) =>
                        setSimpleSchedule((prev) => ({ ...prev, hour: value }))
                      }
                      disabled={isSubmitting}
                    >
                      <SelectTrigger disabled={isSubmitting}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {HOUR_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </Field>
                )}

                {/* Minute selector */}
                <Field className="flex-1">
                  <FieldLabel>Minute</FieldLabel>
                  <Select
                    value={simpleSchedule.minute}
                    onValueChange={(value) =>
                      setSimpleSchedule((prev) => ({ ...prev, minute: value }))
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

              {/* Day of Week selector (only for weekly) */}
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

              {/* Day of Month selector (only for monthly) */}
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

          {/* Advanced Mode - Raw Cron Expression */}
          {scheduleMode === "advanced" && (
            <Field data-invalid={!!validationErrors.cronExpression}>
              <FieldLabel htmlFor="cronExpression">Cron Expression</FieldLabel>
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
                Format: minute hour day-of-month month day-of-week. Example: "0
                9 * * *" runs daily at 9:00 AM.
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
                <p>One-off Schedule</p>
                <p className="text-xs text-muted-foreground">
                  Run once and then disable
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
                  Schedule will run automatically
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
            !isCronValid
          }
        >
          {cronJobId ? "Update" : "Save"}
        </Button>

        {cronJobId && (
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
        title="Delete Schedule"
        description="Are you sure you want to delete this schedule? This will also delete all chat history for this schedule. This action cannot be undone."
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </div>
  );
};

export { CronJobForm };
