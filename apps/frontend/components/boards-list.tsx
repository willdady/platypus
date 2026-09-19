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

export const BoardsList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId: string;
}) => (
  <EntityCardList
    orgId={orgId}
    workspaceId={workspaceId}
    config={boardsConfig}
  />
);
