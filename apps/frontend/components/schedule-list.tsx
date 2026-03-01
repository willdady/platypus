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
  List,
} from "lucide-react";
import { type Schedule } from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import Link from "next/link";
import { useBackendUrl } from "@/app/client-context";
import { useAuth } from "@/components/auth-provider";
import { format } from "date-fns";
import { describeSchedule } from "@/lib/cron-utils";
import { toast } from "sonner";

interface ScheduleListProps {
  orgId: string;
  workspaceId: string;
  schedules: Schedule[];
  onMutate: () => void;
}

export const ScheduleList = ({
  orgId,
  workspaceId,
  schedules,
  onMutate,
}: ScheduleListProps) => {
  const { user } = useAuth();
  const backendUrl = useBackendUrl();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [scheduleToDelete, setScheduleToDelete] = useState<Schedule | null>(
    null,
  );
  const [scheduleToToggle, setScheduleToToggle] = useState<Schedule | null>(
    null,
  );
  const [isToggling, setIsToggling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteClick = (schedule: Schedule) => {
    setScheduleToDelete(schedule);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!scheduleToDelete || !backendUrl) return;

    setIsDeleting(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/schedules/${scheduleToDelete.id}`,
        ),
        {
          method: "DELETE",
          credentials: "include",
        },
      );

      if (response.ok) {
        onMutate();
        setDeleteDialogOpen(false);
        setScheduleToDelete(null);
      }
    } catch (error) {
      toast.error("Failed to delete schedule");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleToggleEnabled = async (schedule: Schedule) => {
    if (!backendUrl) return;

    setScheduleToToggle(schedule);
    setIsToggling(true);
    try {
      const response = await fetch(
        joinUrl(
          backendUrl,
          `/organizations/${orgId}/workspaces/${workspaceId}/schedules/${schedule.id}`,
        ),
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            enabled: !schedule.enabled,
          }),
        },
      );

      if (response.ok) {
        onMutate();
      }
    } catch (error) {
      toast.error("Failed to toggle schedule");
    } finally {
      setIsToggling(false);
      setScheduleToToggle(null);
    }
  };

  if (!schedules.length) {
    return null;
  }

  return (
    <>
      <ul className="grid grid-cols-1 lg:grid-cols-2 grid-rows-1 gap-4">
        {schedules.map((schedule) => (
          <li key={schedule.id}>
            <Item variant="outline" className="h-full">
              <ItemContent>
                <div className="flex items-center gap-2">
                  <ItemTitle>{schedule.name}</ItemTitle>
                  {schedule.isOneOff && (
                    <Badge variant="outline" className="text-xs">
                      One-off
                    </Badge>
                  )}
                  {!schedule.enabled && (
                    <Badge variant="secondary" className="text-xs">
                      Disabled
                    </Badge>
                  )}
                </div>
                {schedule.description && (
                  <ItemDescription className="text-xs">
                    {schedule.description}
                  </ItemDescription>
                )}
                <div className="flex flex-col gap-1 mt-1.5 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Timer className="h-3 w-3" />
                    {describeSchedule(
                      schedule.cronExpression,
                      schedule.timezone,
                    )}
                  </span>
                  {schedule.nextRunAt && schedule.enabled && (
                    <span>
                      Next run: {format(new Date(schedule.nextRunAt), "PPp")}
                    </span>
                  )}
                  {schedule.lastRunAt && (
                    <span>
                      Last run: {format(new Date(schedule.lastRunAt), "PPp")}
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
                    >
                      <EllipsisVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuItem asChild>
                      <Link
                        className="cursor-pointer"
                        href={`/${orgId}/workspace/${workspaceId}/schedules/${schedule.id}`}
                      >
                        <Pencil /> Edit
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem asChild>
                      <Link
                        className="cursor-pointer"
                        href={`/${orgId}/workspace/${workspaceId}/schedules/${schedule.id}/runs`}
                      >
                        <List /> View Runs
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="cursor-pointer"
                      onSelect={() => handleToggleEnabled(schedule)}
                      disabled={
                        isToggling && scheduleToToggle?.id === schedule.id
                      }
                    >
                      {schedule.enabled ? (
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
                      onSelect={() => handleDeleteClick(schedule)}
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
        description={`Are you sure you want to delete "${scheduleToDelete?.name}"? This will also delete all chat history for this schedule. This action cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirm}
        loading={isDeleting}
      />
    </>
  );
};
