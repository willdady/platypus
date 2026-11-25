"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useScopedList } from "@/hooks/use-scoped-list";
import { ListError, ListState } from "@/components/list-state";
import { LoadingRegion, SkeletonLine } from "@/components/list-skeletons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type {
  KanbanCardHistoryChange,
  KanbanCardHistoryEntry,
  KanbanCardHistoryRef,
} from "@platypus/schemas";
import { formatDate, formatDateTime } from "@/lib/format-date";

function labelNames(labels: KanbanCardHistoryRef[]): string {
  return labels.length > 0
    ? labels.map((label) => label.name).join(", ")
    : "none";
}

// why: heavier weight so a Column or Label named "none" still reads as a value
function Value({ children }: { children: ReactNode }) {
  return <span className="font-medium text-foreground">{children}</span>;
}

// why: entries carry snapshots, and the body has none, so it reads as an edit
function describeChange(change: KanbanCardHistoryChange): ReactNode {
  switch (change.field) {
    case "columnId":
      return change.before === null ? (
        <>
          created in <Value>{change.after.name}</Value>
        </>
      ) : (
        <>
          moved from <Value>{change.before.name}</Value> to{" "}
          <Value>{change.after.name}</Value>
        </>
      );
    case "title":
      return (
        <>
          renamed to <Value>{change.after ?? ""}</Value>
        </>
      );
    case "body":
      return "edited the description";
    case "priority":
      return (
        <>
          priority <Value>{change.before}</Value> →{" "}
          <Value>{change.after}</Value>
        </>
      );
    case "dueDate":
      return (
        <>
          due date{" "}
          <Value>{change.before ? formatDate(change.before) : "none"}</Value> →{" "}
          <Value>{change.after ? formatDate(change.after) : "none"}</Value>
        </>
      );
    case "labelIds":
      return (
        <>
          labels <Value>{labelNames(change.before)}</Value> →{" "}
          <Value>{labelNames(change.after)}</Value>
        </>
      );
    case "assignees":
      // why: an assignee change carries only ids, so it is described not named
      if (change.before.length === 0) return "assigned the card";
      if (change.after.length === 0) return "removed the assignee";
      return "changed the assignee";
  }
}

// why: history can be long, so the section opens closed and reads nothing until then
export function KanbanCardHistory({
  orgId,
  workspaceId,
  boardId,
  cardId,
}: {
  orgId: string;
  workspaceId: string;
  boardId: string;
  cardId: string;
}) {
  const [open, setOpen] = useState(false);

  const {
    data,
    results: entries,
    error,
    mutate,
  } = useScopedList<KanbanCardHistoryEntry>(
    `boards/${boardId}/cards/${cardId}/history`,
    open ? { orgId, workspaceId } : null,
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left text-sm font-medium">
        History
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden">
        <div className="pt-3">
          {error && !data ? (
            <ListError
              error={error}
              subject="history"
              onRetry={() => mutate()}
            />
          ) : !data ? (
            <LoadingRegion label="Loading history">
              <ol className="flex flex-col gap-3">
                {[0, 1, 2].map((i) => (
                  <li key={i} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <SkeletonLine lineClassName="h-4" className="h-3 w-16" />
                      <SkeletonLine lineClassName="h-4" className="h-3 w-24" />
                    </div>
                    <ul className="flex flex-col gap-0.5">
                      <li>
                        <SkeletonLine
                          lineClassName="h-4"
                          className="h-3 w-3/4"
                        />
                      </li>
                      {i === 0 && (
                        <li>
                          <SkeletonLine
                            lineClassName="h-4"
                            className="h-3 w-1/2"
                          />
                        </li>
                      )}
                    </ul>
                  </li>
                ))}
              </ol>
            </LoadingRegion>
          ) : entries.length === 0 ? (
            <ListState variant="empty">No changes recorded yet.</ListState>
          ) : (
            <ol className="flex flex-col gap-3">
              {entries.map((entry) => (
                <li key={entry.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">
                      {entry.actorName ?? "Unknown"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </div>
                  <ul className="text-xs text-muted-foreground flex flex-col gap-0.5">
                    {entry.changes.map((change, index) => (
                      <li key={`${entry.id}-${index}`}>
                        {describeChange(change)}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
