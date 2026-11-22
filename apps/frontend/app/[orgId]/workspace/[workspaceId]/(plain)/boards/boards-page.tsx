"use client";

import { use } from "react";
import { BoardsList } from "@/components/boards-list";
import { ListError } from "@/components/list-state";
import { NoProvidersEmptyState } from "@/components/no-providers-empty-state";
import { PageHeader } from "@/components/page-header";
import { useScopedList } from "@/hooks/use-scoped-list";

/**
 * The Workspace's Boards. A screen of its own rather than a section on the
 * Workspace home, so the Boards area has somewhere to land from a Board.
 * Boards need a Provider, so a Workspace without one gets the same prompt the
 * Workspace home shows instead of the list.
 */
export default function BoardsPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = use(params);

  const {
    data: providersData,
    results: providers,
    error: providersError,
    isLoading: isLoadingProviders,
    mutate: mutateProviders,
  } = useScopedList<unknown>("providers", { orgId, workspaceId });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <PageHeader
        title="Boards"
        description="Visual work management boards for organizing tasks."
      />
      {/* PageHeader spaces itself, so the gap belongs to the content alone. */}
      <div className="flex flex-col gap-4">
        {providersError && !providersData ? (
          // Without the count there is no telling a Workspace with no
          // Providers from one whose Providers didn't load.
          <ListError
            error={providersError}
            subject="providers"
            onRetry={() => void mutateProviders()}
          />
        ) : !isLoadingProviders && providers.length === 0 ? (
          <NoProvidersEmptyState orgId={orgId} workspaceId={workspaceId} />
        ) : (
          <BoardsList orgId={orgId} workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
