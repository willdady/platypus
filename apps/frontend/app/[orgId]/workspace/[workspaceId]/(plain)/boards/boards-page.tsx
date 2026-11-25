"use client";

import { use } from "react";
import { BoardsList } from "@/components/boards-list";
import { ListError } from "@/components/list-state";
import { NoProvidersEmptyState } from "@/components/no-providers-empty-state";
import { PageHeader } from "@/components/page-header";
import { useScopedList } from "@/hooks/use-scoped-list";

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
      <div className="flex flex-col gap-4">
        {providersError && !providersData ? (
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
