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
    detachTitle: "Organization Provider",
    noun: "provider",
    plural: "providers",
  },
  emptyState: NoProvidersEmptyState,
};

export const ProvidersList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId?: string;
}) => (
  <ResourceList
    orgId={orgId}
    workspaceId={workspaceId}
    config={providersConfig}
  />
);
