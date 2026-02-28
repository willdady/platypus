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
  Play,
  EllipsisVertical,
  Pencil,
  Trash2,
  Pause,
} from "lucide-react";
import { type CronJob } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { format } from "date-fns";
import { Cron } from "croner";

interface CronJobListProps {
  orgId: string;
  workspaceId: string;
  cronJobs: CronJob[];
  onMutate: () => void;
}

const TIMEZONES = Intl.supportedValuesOf("timeZone");

// Human-readable schedule description
const describeSchedule = (cronExpression: string, timezone: string): string => {
  try {
    const cron = new Cron(cronExpression, { timezone });
    const next = cron.nextRun();
    if (!next) return "Invalid schedule";

    // Parse cron expression to describe it
    const parts = cronExpression.split(" ");
    if (parts.length !== 5) return cronExpression;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Common patterns
    if (
      minute === "*" &&
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return "Every minute";
    }
    if (
      hour === "*" &&
      dayOfMonth === "*" &&
      month === "*" &&
      dayOfWeek === "*"
    ) {
      return `Every hour at minute ${minute}`;
    }
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      return `Daily at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} ${timezone}`;
    }
    if (month === "*" && dayOfWeek === "*") {
      return `Monthly on day ${dayOfMonth} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} ${timezone}`;
    }
    if (dayOfMonth === "*" && month === "*") {
      const days = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
      ];
      const dayNum = parseInt(dayOfWeek);
      if (!isNaN(dayNum)) {
        return `Weekly on ${days[dayNum]} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")} ${timezone}`;
      }
    }

    return cronExpression;
  } catch {
    return cronExpression;
  }
};

export const CronJobList = ({
  orgId,
  workspaceId,
  cronJobs,
  onMutate,
}: CronJobListProps) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [cronJobToDelete, setCronJobToDelete] = useState<CronJob | null>(null);
  const [cronJobToToggle, setCronJobToToggle] = useState<CronJob | null>(null);
  const [cronJobToTrigger, setCronJobToTrigger] = useState<CronJob | null>(
    null,
  );
  const [isToggling, setIsToggling] = useState(false);
  const [isTriggering, setIsTriggering] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [triggerResult, setTriggerResult] = useState<{ chatId: string } | null>(
    null,
  );
  const [triggerDialogOpen, setTriggerDialogOpen] = useState(false);

  const handleDeleteClick = (cronJob: CronJob) => {
    setCronJobToDelete(cronJob);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!cronJobToDelete || !backendUrl) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs/${cronJobToDelete.id}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        onMutate();
        setDeleteDialogOpen(false);
        setCronJobToDelete(null);
      }
    } catch (error) {
      console.error("Failed to delete cron job:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleEnabled = async (cronJob: CronJob) => {
    if (!backendUrl) return;

    setCronJobToToggle(cronJob);
    setIsToggling(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs/${cronJob.id}`,
        ),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            ...cronJob,
            enabled: !cronJob.enabled,
          }),
        },
      );

      if (response.ok) {
        onMutate();
      }
    } catch (error) {
      console.error("Failed to toggle cron job:", error);
    } finally {
      setIsToggling(false);
      setCronJobToToggle(null);
    }
  };

  const handleTrigger = async (cronJob: CronJob) => {
    if (!backendUrl) return;

    setCronJobToTrigger(cronJob);
    setIsTriggering(true);
    setTriggerResult(null);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/cron-jobs/${cronJob.id}/trigger`,
        ),
        {
          method: "POST",
          credentials: "include",
        },
      );

      if (response.ok) {
        const data = await response.json();
        setTriggerResult(data);
        setTriggerDialogOpen(true);
      } else {
        const error = await response.json();
        console.error("Failed to trigger cron job:", error);
      }
    } catch (error) {
      console.error("Failed to trigger cron job:", error);
    } finally {
      setIsTriggering(false);
      setCronJobToTrigger(null);
    }
  };

  if (!cronJobs.length) {
    return null;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-4">
        {cronJobs.map((cronJob) => (
          <li key={cronJob.id}>
            <Item variant="outline" className="h-full">
              <ItemContent>
                <div className="flex items-center gap-2">
                  <ItemTitle>{cronJob.name}</ItemTitle>
                  {cronJob.isOneOff && (
                    <Badge variant="outline" className="text-xs">
                      One-off
                    </Badge>
                  )}
                  {!cronJob.enabled && (
                    <Badge variant="secondary" className="text-xs">
                      Disabled
                    </Badge>
                  )}
                </div>
                {cronJob.description && (
                  <ItemDescription className="text-xs">
                    {cronJob.description}
                  </ItemDescription>
                )}
                <div className="flex flex-col gap-1 mt-1.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Timer className="h-3 w-3" />
                    {describeSchedule(cronJob.cronExpression, cronJob.timezone)}
                  </span>
                  {cronJob.nextRunAt && cronJob.enabled && (
                    <span>
                      Next run: {format(new Date(cronJob.nextRunAt), "PPp")}
                    </span>
                  )}
                  {cronJob.lastRunAt && (
                    <span>
                      Last run: {format(new Date(cronJob.lastRunAt), "PPp")}
                    </span>
                  )}
                </div>
              </ItemContent>
              <ItemActions className="gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleTrigger(cronJob)}
                  disabled={isTriggering && cronJobToTrigger?.id === cronJob.id}
                >
                  <Play className="h-4 w-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      className="cursor-pointer text-muted-foreground"
                      variant="ghost"
                      size="icon"
                    >
                      <EllipsisVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem asChild>
                      <Link
                        className="cursor-pointer"
                        href={`/${orgId}/workspace/${workspaceId}/cron-jobs/${cronJob.id}`}
                      >
                        <Pencil /> Edit
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => handleToggleEnabled(cronJob)}
                      disabled={
                        isToggling && cronJobToToggle?.id === cronJob.id
                      }
                    >
                      {cronJob.enabled ? (
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
                      onSelect={() => handleDeleteClick(cronJob)}
                    >
                      <Trash2 /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </ItemActions>
            </Item>
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Schedule"
        description={`Are you sure you want to delete "${cronJobToDelete?.name}"? This will also delete all chat history for this schedule. This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
        loading={isDeleting}
      />

      <ConfirmDialog
        open={triggerDialogOpen}
        onOpenChange={setTriggerDialogOpen}
        title="Schedule Triggered"
        description="The schedule has been triggered successfully. A new chat has been created."
        confirmLabel="View Chat"
        confirmVariant="default"
        onConfirm={() => {
          if (triggerResult) {
            window.location.href = `/${orgId}/workspace/${workspaceId}/chat/${triggerResult.chatId}`;
          }
        }}
      />
    </>
  );
};
