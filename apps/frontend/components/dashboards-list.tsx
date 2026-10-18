"use client";

import {
  WorkspaceEntityCardList,
  type WorkspaceEntityCardListConfig,
} from "./entity-card-list";

const dashboardsConfig: WorkspaceEntityCardListConfig = {
  entity: "dashboards",
  queryParam: "dashboardQuery",
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
    <WorkspaceEntityCardList
      orgId={orgId}
      workspaceId={workspaceId}
      config={dashboardsConfig}
    />
  );
}
