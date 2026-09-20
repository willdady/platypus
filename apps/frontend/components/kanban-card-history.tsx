"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type {
  KanbanCardHistoryChange,
  KanbanCardHistoryRef,
} from "@platypus/schemas";

/**
 * A card's history as the API returns it — timestamps arrive as JSON strings
 * rather than the `Date` the shared schema describes.
 */
type HistoryEntry = {
  id: string;
  kind: "created" | "updated";
  changes: KanbanCardHistoryChange[];
  actorName?: string | null;
  createdAt: string;
};

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString() : "none";

const formatTimestamp = (value: string): string =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

const labelNames = (labels: KanbanCardHistoryRef[]): string =>
  labels.length > 0 ? labels.map((label) => label.name).join(", ") : "none";

/**
 * A value a change moved between. Rendered heavier than the sentence around it
 * so a Column or Label called "moved" or "none" still reads as the value
 * rather than as part of the wording.
 */
const Value = ({ children }: { children: ReactNode }) => (
  <span className="font-medium text-foreground">{children}</span>
);

/**
 * One change, in a sentence. Values are the snapshots the entry was written
 * with, so a renamed Column still reads as the name it had at the time — and
 * the body, which is recorded without its text, reads as an edit rather than a
 * diff.
 */
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
          due date <Value>{formatDate(change.before)}</Value> →{" "}
          <Value>{formatDate(change.after)}</Value>
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
      // Only ids are recorded for an assignee, so the change is described
      // rather than named.
      if (change.before.length === 0) return "assigned the card";
      if (change.after.length === 0) return "removed the assignee";
      return "changed the assignee";
  }
}

/**
 * A Card's history: how it reached its current state, newest first. Read-only
 * and capped by the backend, so there is nothing here to page through.
 *
 * Collapsed on open, and not fetched until it is expanded: a Card can carry up
 * to `KANBAN_CARD_HISTORY_LIMIT` entries, which would otherwise push the
 * comments — the part of the dialog people come to read — off the screen.
 */
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

  // A closed section names no scope, so nothing is read until it opens.
  const { data } = useScopedSWR<{ results: HistoryEntry[] }>(
    `boards/${boardId}/cards/${cardId}/history`,
    open ? { orgId, workspaceId } : null,
  );
  const entries = data?.results ?? [];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-left text-sm font-medium">
        History
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=closed]:-rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up overflow-hidden">
        <div className="pt-3">
          {!data ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No changes recorded yet.
            </p>
          ) : (
            <ol className="space-y-3">
              {entries.map((entry) => (
                <li key={entry.id} className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">
                      {entry.actorName ?? "Unknown"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(entry.createdAt)}
                    </span>
                  </div>
                  <ul className="text-xs text-muted-foreground space-y-0.5">
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
