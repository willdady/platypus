"use client";

import {
  WorkspaceEntityCardList,
  type WorkspaceEntityCardListConfig,
} from "./entity-card-list";

const boardsConfig: WorkspaceEntityCardListConfig = {
  entity: "boards",
  queryParam: "boardQuery",
  labels: {
    deleteTitle: "Delete Board",
    deleteNoun: "board",
    deleteTail: "and all of its data.",
    confirmPhrase: "delete board",
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
