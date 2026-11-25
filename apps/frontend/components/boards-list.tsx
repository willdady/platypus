"use client";

import { defaultFilter } from "cmdk";
import { KanbanSquare, Plus } from "lucide-react";
import Link from "next/link";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyCard } from "@/components/empty-card";
import { EntityCardList } from "@/components/entity-card-list";
import { ListState } from "@/components/list-state";
import { CardGridSkeleton } from "@/components/list-skeletons";
import { ListFooter, ListPagination } from "@/components/list-pagination";
import { ListToolbar } from "@/components/list-toolbar";
import { RowActionsMenu } from "@/components/row-actions-menu";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { useDeleteFlow } from "@/hooks/use-delete-flow";
import { useListParams, useSearchParamInput } from "@/hooks/use-list-params";
import { useScopedList } from "@/hooks/use-scoped-list";
import { writeEntity } from "@/lib/api-write";
import { workspaceRoutes } from "@/lib/routes";
import { sortByName } from "@/lib/utils";

const BOARDS_PAGE_SIZE = 8;
const QUERY_PARAM = "boardQuery";
const PAGE_PARAM = "boardsPage";

type BoardCard = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

export function BoardsList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const {
    data,
    results: rows,
    error,
    isLoading,
    mutate,
  } = useScopedList<BoardCard>("boards", { orgId, workspaceId });

  const { page: pageItems } = useListParams(PAGE_PARAM);
  const { value: nameFilter, onValueChange: setNameFilter } =
    useSearchParamInput(QUERY_PARAM, PAGE_PARAM);

  const routes = workspaceRoutes(orgId, workspaceId).boards;

  const query = nameFilter.trim();
  const cards = sortByName(rows).filter(
    (card) => !query || defaultFilter(card.name, query) > 0,
  );
  const page = pageItems(cards, BOARDS_PAGE_SIZE);

  const deleteFlow = useDeleteFlow<BoardCard>({
    mutate,
    delete: (card, backendUrl) =>
      writeEntity(
        backendUrl,
        "boards",
        { orgId, workspaceId },
        {
          id: card.id,
        },
      ),
  });

  const actions = (
    <Button variant={rows.length === 0 ? "default" : "outline"} asChild>
      <Link href={routes.create}>
        <Plus /> Create board
      </Link>
    </Button>
  );

  return (
    <>
      {rows.length > 0 && (
        <ListToolbar>
          <SearchInput
            placeholder={"Search boards..."}
            aria-label={"Search boards"}
            value={nameFilter}
            onValueChange={setNameFilter}
            className="w-full sm:w-64"
          />
        </ListToolbar>
      )}
      <EntityCardList
        items={page.items}
        ghosts={page}
        isLoading={isLoading}
        error={error}
        data={data}
        subject="boards"
        onRetry={() => void mutate()}
        skeleton={<CardGridSkeleton descriptionLines={1} />}
        empty={
          rows.length === 0 ? (
            <EmptyCard
              icon={<KanbanSquare />}
              title="No boards yet"
              description="Create a board to arrange work in columns and move cards across them."
              action={actions}
            />
          ) : (
            <ListState variant="empty">No boards match your filters.</ListState>
          )
        }
        descriptionLines={1}
        href={(card) => routes.detail(card.id)}
        menu={(card) => (
          <RowActionsMenu
            name={card.name}
            edit={{ href: routes.settings(card.id) }}
            remove={{ onSelect: () => deleteFlow.request(card) }}
          />
        )}
      />

      {rows.length > 0 && (
        <ListFooter
          pagination={
            <ListPagination
              page={page}
              param={PAGE_PARAM}
              aria-label="Boards pages"
            />
          }
        >
          {actions}
        </ListFooter>
      )}

      <DeleteConfirmDialog
        noun="board"
        name={deleteFlow.target?.name}
        consequence="This also deletes all of its data."
        requireTypedConfirmation
        {...deleteFlow.dialogProps}
      />
    </>
  );
}
