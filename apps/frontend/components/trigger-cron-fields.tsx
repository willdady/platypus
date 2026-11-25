"use client";

import { Field, FieldTitle } from "@/components/ui/field";
import { FormTextField } from "@/components/form-text-field";
import { FormSelectField } from "@/components/form-select-field";
import { FormSwitchField } from "@/components/form-switch-field";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { SelectGroup, SelectItem } from "@/components/ui/select";
import { useAuth } from "@/components/auth-provider";
import { useResetOnChange } from "@/hooks/use-reset-on-change";
import { useEffect, useMemo, useState } from "react";
import { Cron } from "croner";
import { formatDateTime } from "@/lib/format-date";
import {
  buildCronExpression,
  parseCronExpression,
  type Frequency,
  type SimpleSchedule,
} from "@/lib/cron";
import { getBrowserTimezone, TIMEZONES } from "@/lib/timezones";
import type { TriggerFieldsProps } from "@/components/trigger-form";

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

const DEFAULT_CRON_EXPRESSION = "0 9 * * *";

const DEFAULT_SIMPLE_SCHEDULE: SimpleSchedule = {
  frequency: "daily",
  minute: "0",
  hour: "9",
  dayOfWeek: "1",
  dayOfMonth: "1",
};

function TriggerCronFields({
  active,
  trigger,
  disabled,
  errors,
  clearErrors,
  onChange,
}: TriggerFieldsProps) {
  const saved = trigger?.type === "cron" ? trigger.config : undefined;
  const { user } = useAuth();

  const [scheduleMode, setScheduleMode] = useState<"simple" | "advanced">(() =>
    saved && !parseCronExpression(saved.cronExpression) ? "advanced" : "simple",
  );
  const [simpleSchedule, setSimpleSchedule] = useState<SimpleSchedule>(
    () =>
      (saved && parseCronExpression(saved.cronExpression)) ??
      DEFAULT_SIMPLE_SCHEDULE,
  );
  const [cronExpression, setCronExpression] = useState(
    saved?.cronExpression ?? DEFAULT_CRON_EXPRESSION,
  );
  const [timezone, setTimezone] = useState(
    () => saved?.timezone ?? user?.timezone ?? getBrowserTimezone(),
  );
  const [timezoneTouched, setTimezoneTouched] = useState(false);
  const [isOneOff, setIsOneOff] = useState(saved?.isOneOff ?? false);

  useResetOnChange(user?.timezone, () => {
    const userTimezone = user?.timezone;
    if (trigger || !userTimezone || timezoneTouched) return;
    setTimezone(userTimezone);
  });

  const fired = !!trigger?.firedAt;
  const scheduleLocked = disabled || fired;

  const effectiveCronExpression =
    scheduleMode === "simple"
      ? buildCronExpression(
          simpleSchedule.frequency,
          simpleSchedule.minute,
          simpleSchedule.hour,
          simpleSchedule.dayOfWeek,
          simpleSchedule.dayOfMonth,
        )
      : cronExpression;

  const { isCronValid, nextRunPreview } = useMemo(() => {
    try {
      const cron = new Cron(effectiveCronExpression, { timezone });
      const next = cron.nextRun();
      return {
        isCronValid: true,
        nextRunPreview: next ? formatDateTime(next) : null,
      };
    } catch {
      return { isCronValid: false, nextRunPreview: null };
    }
  }, [effectiveCronExpression, timezone]);

  useEffect(() => {
    onChange({
      type: "cron",
      config: { cronExpression: effectiveCronExpression, timezone, isOneOff },
      valid: isCronValid,
    });
  }, [onChange, effectiveCronExpression, timezone, isOneOff, isCronValid]);

  if (!active) return null;

  return (
    <>
      {fired && (
        <p className="text-sm text-muted-foreground">
          This One-off Trigger has fired, so its schedule can&apos;t change and
          it can&apos;t be enabled again. Create a new Trigger to run it again.
        </p>
      )}
      <Field aria-labelledby="trigger-schedule-mode-label">
        <FieldTitle id="trigger-schedule-mode-label">Schedule Mode</FieldTitle>
        <ButtonGroup>
          <Button
            type="button"
            variant={scheduleMode === "simple" ? "default" : "outline"}
            onClick={() => setScheduleMode("simple")}
            disabled={scheduleLocked}
          >
            Simple
          </Button>
          <Button
            type="button"
            variant={scheduleMode === "advanced" ? "default" : "outline"}
            onClick={() => {
              setScheduleMode("advanced");
              setCronExpression(effectiveCronExpression);
            }}
            disabled={scheduleLocked}
          >
            Advanced
          </Button>
        </ButtonGroup>
      </Field>

      {scheduleMode === "simple" && (
        <>
          <FormSelectField
            label="Frequency"
            name="trigger-frequency"
            value={simpleSchedule.frequency}
            onValueChange={(value) =>
              setSimpleSchedule((prev) => ({
                ...prev,
                frequency: value as Frequency,
              }))
            }
            disabled={scheduleLocked}
          >
            <SelectGroup>
              <SelectItem value="every-5-minutes">Every 5 minutes</SelectItem>
              <SelectItem value="every-10-minutes">Every 10 minutes</SelectItem>
              <SelectItem value="every-15-minutes">Every 15 minutes</SelectItem>
              <SelectItem value="every-30-minutes">Every 30 minutes</SelectItem>
              <SelectItem value="hourly">Hourly</SelectItem>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
            </SelectGroup>
          </FormSelectField>

          {simpleSchedule.frequency !== "every-5-minutes" &&
            simpleSchedule.frequency !== "every-10-minutes" &&
            simpleSchedule.frequency !== "every-15-minutes" &&
            simpleSchedule.frequency !== "every-30-minutes" && (
              <div className="flex gap-4">
                {simpleSchedule.frequency !== "hourly" && (
                  <FormSelectField
                    label="Hour"
                    name="trigger-hour"
                    className="flex-1"
                    value={simpleSchedule.hour}
                    onValueChange={(value) =>
                      setSimpleSchedule((prev) => ({
                        ...prev,
                        hour: value,
                      }))
                    }
                    disabled={scheduleLocked}
                  >
                    <SelectGroup>
                      {HOUR_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </FormSelectField>
                )}

                <FormSelectField
                  label="Minute"
                  name="trigger-minute"
                  className="flex-1"
                  value={simpleSchedule.minute}
                  onValueChange={(value) =>
                    setSimpleSchedule((prev) => ({
                      ...prev,
                      minute: value,
                    }))
                  }
                  disabled={scheduleLocked}
                >
                  <SelectGroup>
                    {MINUTE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </FormSelectField>
              </div>
            )}

          {simpleSchedule.frequency === "weekly" && (
            <FormSelectField
              label="Day of Week"
              name="trigger-day-of-week"
              value={simpleSchedule.dayOfWeek}
              onValueChange={(value) =>
                setSimpleSchedule((prev) => ({
                  ...prev,
                  dayOfWeek: value,
                }))
              }
              disabled={scheduleLocked}
            >
              <SelectGroup>
                {DAYS_OF_WEEK.map((day) => (
                  <SelectItem key={day.value} value={day.value}>
                    {day.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </FormSelectField>
          )}

          {simpleSchedule.frequency === "monthly" && (
            <FormSelectField
              label="Day of Month"
              name="trigger-day-of-month"
              value={simpleSchedule.dayOfMonth}
              onValueChange={(value) =>
                setSimpleSchedule((prev) => ({
                  ...prev,
                  dayOfMonth: value,
                }))
              }
              disabled={scheduleLocked}
            >
              <SelectGroup>
                {DAY_OF_MONTH_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </FormSelectField>
          )}
        </>
      )}

      {scheduleMode === "advanced" && (
        <FormTextField
          label="Cron Expression"
          name="cronExpression"
          placeholder="0 9 * * *"
          value={cronExpression}
          onChange={(value) => {
            clearErrors("cronExpression");
            setCronExpression(value);
          }}
          disabled={scheduleLocked}
          inputClassName={!isCronValid ? "border-destructive" : ""}
          error={
            errors.cronExpression ||
            (!isCronValid ? "Invalid cron expression" : undefined)
          }
          description={
            <>
              Format: minute hour day-of-month month day-of-week. Example:
              &quot;0 9 * * *&quot; runs daily at 9:00 AM.
            </>
          }
        />
      )}

      <FormSelectField
        label="Timezone"
        name="timezone"
        value={timezone}
        onValueChange={(value) => {
          setTimezoneTouched(true);
          clearErrors("timezone");
          setTimezone(value);
        }}
        disabled={scheduleLocked}
        placeholder="Select timezone"
        error={errors.timezone}
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
          <FieldTitle>Next Run Preview</FieldTitle>
          <div className="text-sm text-muted-foreground p-2 bg-muted rounded-md">
            {nextRunPreview}
          </div>
        </Field>
      )}

      <FormSwitchField
        name="isOneOff"
        label="One-off Trigger"
        description="Run once and then disable"
        checked={isOneOff}
        onCheckedChange={setIsOneOff}
        disabled={scheduleLocked}
      />
    </>
  );
}

export { TriggerCronFields };
