"use client";

import { EntityCardList, type EntityCardListConfig } from "./entity-card-list";

const boardsConfig: EntityCardListConfig = {
  entity: "boards",
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
    <EntityCardList
      orgId={orgId}
      workspaceId={workspaceId}
      config={boardsConfig}
    />
  );
}
