"use client";

import { use } from "react";
import { BoardsList } from "@/components/boards-list";
import { PageHeader } from "@/components/page-header";

/**
 * The Workspace's Boards. A screen of its own rather than a section on the
 * Workspace home, so the Boards area has somewhere to land from a Board.
 */
export default function BoardsPage({
  params,
}: {
  params: Promise<{ orgId: string; workspaceId: string }>;
}) {
  const { orgId, workspaceId } = use(params);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
      <PageHeader
        title="Boards"
        description="Visual work management boards for organizing tasks."
      />
      {/* PageHeader spaces itself, so the gap belongs to the list alone. */}
      <div className="flex flex-col gap-4">
        <BoardsList orgId={orgId} workspaceId={workspaceId} />
      </div>
    </div>
  );
}
