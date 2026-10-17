import type { KanbanBoard, KanbanBoardState, Trigger } from "@platypus/schemas";
import { useScopedSWR } from "@/hooks/use-scoped-swr";
import type { Scope, Serialized } from "@/lib/api-write";

/**
 * Whether the lists a saved board/column filter names are still loading. The
 * form waits on them so the filter shows a name rather than a blank Select.
 * Only a *saved* column waits on its board's columns: picking another board
 * clears the column, so a later board change never swaps the whole form back
 * for the skeleton.
 */
export function useEventFilterListsLoading(
  trigger: Serialized<Trigger> | undefined,
  scope: Scope,
) {
  const { isLoading: boardsLoading } = useScopedSWR<{
    results: KanbanBoard[];
  }>("boards", scope);
  const filters = trigger?.type === "event" ? trigger.config.filters : null;
  const { isLoading: columnsLoading } = useScopedSWR<KanbanBoardState>(
    `boards/${filters?.boardId}/state`,
    filters?.boardId && filters.columnId ? scope : null,
  );
  return boardsLoading || columnsLoading;
}
