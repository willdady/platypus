"use client";

import useSWR from "swr";
import type {
  KanbanCardHistoryChange,
  KanbanCardHistoryRef,
} from "@platypus/schemas";
import { fetcher, joinUrl } from "@/lib/utils";
import { useBackendUrl } from "@/app/client-context";

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
 * One change, in a sentence. Values are the snapshots the entry was written
 * with, so a renamed Column still reads as the name it had at the time — and
 * the body, which is recorded without its text, reads as an edit rather than a
 * diff.
 */
function describeChange(change: KanbanCardHistoryChange): string {
  switch (change.field) {
    case "columnId":
      return change.before === null
        ? `created in ${change.after.name}`
        : `moved from ${change.before.name} to ${change.after.name}`;
    case "title":
      return `renamed to "${change.after ?? ""}"`;
    case "body":
      return "edited the description";
    case "priority":
      return `priority ${change.before} → ${change.after}`;
    case "dueDate":
      return `due date ${formatDate(change.before)} → ${formatDate(change.after)}`;
    case "labelIds":
      return `labels ${labelNames(change.before)} → ${labelNames(change.after)}`;
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
  const backendUrl = useBackendUrl();

  const url =
    backendUrl &&
    joinUrl(
      backendUrl,
      `/organizations/${orgId}/workspaces/${workspaceId}/boards/${boardId}/cards/${cardId}/history`,
    );

  const { data } = useSWR<{ results: HistoryEntry[] }>(url, fetcher);
  const entries = data?.results ?? [];

  return (
    <div>
      <p className="text-sm font-medium mb-3">History</p>
      {entries.length === 0 ? (
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
                  <li key={`${entry.id}-${index}`}>{describeChange(change)}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
