"use client";

import { NoProvidersEmptyState } from "./no-providers-empty-state";
import { ResourceList, type ResourceListConfig } from "./resource-list";

const providersConfig: ResourceListConfig = {
  entity: "providers",
  resourceType: "provider",
  settingsKey: "providers",
  delegationFlag: "providerSelfManagement",
  labels: {
    add: "Add provider",
    attach: "Attach shared provider",
    noun: "provider",
    plural: "providers",
  },
  secondLine: "providerType",
  emptyState: NoProvidersEmptyState,
};

export function ProvidersList({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId?: string;
}) {
  return (
    <ResourceList
      orgId={orgId}
      workspaceId={workspaceId}
      config={providersConfig}
    />
  );
}
