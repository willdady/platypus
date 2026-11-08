"use client";

import { defaultFilter } from "cmdk";
import { Plus } from "lucide-react";
import Link from "next/link";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
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

/** Boards per page on the Workspace home. */
const BOARDS_PAGE_SIZE = 8;
/** The URL param holding the name search. */
const QUERY_PARAM = "boardQuery";
/** The URL param holding the page. */
const PAGE_PARAM = "boardsPage";

type BoardCard = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
};

/**
 * The Workspace's Boards, sorted by name and searchable. Each card links to
 * its Board and carries the edit/delete menu.
 */
export function BoardsList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  const {
    results: rows,
    error,
    isLoading,
    mutate,
  } = useScopedList<BoardCard>("boards", { orgId, workspaceId });

  const { page: pageItems } = useListParams(PAGE_PARAM);
  // An empty search leaves its param out. A new search starts on page 1.
  const { value: nameFilter, onValueChange: setNameFilter } =
    useSearchParamInput(QUERY_PARAM, PAGE_PARAM);

  const routes = workspaceRoutes(orgId, workspaceId).boards;

  const query = nameFilter.trim();
  // The Command palette's own scorer, applied to the name.
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

  return (
    <>
      {/* Nothing to filter, no controls. */}
      {rows.length > 0 && (
        <ListToolbar>
          <SearchInput
            placeholder={"Search boards…"}
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
        subject="boards"
        onRetry={() => void mutate()}
        skeleton={<CardGridSkeleton descriptionLines={1} />}
        empty={
          <ListState variant="empty">
            {rows.length ? "No boards match your filters." : "No boards yet."}
          </ListState>
        }
        // Nothing follows the description, so one line is all it reserves.
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

      <ListFooter
        pagination={
          <ListPagination
            page={page}
            param={PAGE_PARAM}
            aria-label="Boards pages"
          />
        }
      >
        <Button variant="outline" asChild>
          <Link href={routes.create}>
            <Plus /> Create board
          </Link>
        </Button>
      </ListFooter>

      <DeleteConfirmDialog
        open={deleteFlow.open}
        onOpenChange={(open) => !open && deleteFlow.close()}
        title="Delete Board"
        description={
          <>
            This action cannot be undone. This will permanently delete the board{" "}
            <span className="font-semibold">
              {deleteFlow.target?.name ?? ""}
            </span>{" "}
            and all of its data.
          </>
        }
        confirmPhrase="delete board"
        onConfirm={deleteFlow.confirm}
        loading={deleteFlow.deleting}
        error={deleteFlow.error}
      />
    </>
  );
}
