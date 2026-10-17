"use client";

import { EntityCardList, type EntityCardListConfig } from "./entity-card-list";

const dashboardsConfig: EntityCardListConfig = {
  entity: "dashboards",
  labels: {
    deleteTitle: "Delete Dashboard",
    deleteNoun: "dashboard",
    deleteTail: "and all of its widgets.",
    confirmPhrase: "delete dashboard",
  },
};

export function DashboardsList({
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
      config={dashboardsConfig}
    />
  );
}
