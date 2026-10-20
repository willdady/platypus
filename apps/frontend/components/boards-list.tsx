"use client";

import {
  WorkspaceEntityCardList,
  type WorkspaceEntityCardListConfig,
} from "./entity-card-list";

/** Boards per page on the Workspace home. */
const BOARDS_PAGE_SIZE = 8;

const boardsConfig: WorkspaceEntityCardListConfig = {
  entity: "boards",
  queryParam: "boardQuery",
  labels: {
    deleteTitle: "Delete Board",
    deleteNoun: "board",
    deleteTail: "and all of its data.",
    confirmPhrase: "delete board",
  },
  paging: {
    param: "boardsPage",
    pageSize: BOARDS_PAGE_SIZE,
    label: "Boards pages",
    createLabel: "Create board",
  },
};

export function BoardsList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) {
  return (
    <WorkspaceEntityCardList
      orgId={orgId}
      workspaceId={workspaceId}
      config={boardsConfig}
    />
  );
}
