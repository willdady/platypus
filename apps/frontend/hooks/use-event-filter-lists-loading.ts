import type { KanbanBoard, KanbanBoardState, Trigger } from "@platypus/schemas";
import { useScopedList } from "@/hooks/use-scoped-list";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import type { Scope, Serialized } from "@/lib/api-write";

export function useEventFilterListsLoading(
  trigger: Serialized<Trigger> | undefined,
  scope: Scope,
) {
  const { isLoading: boardsLoading } = useScopedList<KanbanBoard>(
    "boards",
    scope,
  );
  const filters = trigger?.type === "event" ? trigger.config.filters : null;
  // why: only a saved column waits on columns, so a board change shows no skeleton
  const { isLoading: columnsLoading } = useScopedSWR<KanbanBoardState>(
    `boards/${filters?.boardId}/state`,
    filters?.boardId && filters.columnId ? scope : null,
  );
  return boardsLoading || columnsLoading;
}
