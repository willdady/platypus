"use client";

import { NoMcpEmptyState } from "./no-mcp-empty-state";
import { ResourceList, type ResourceListConfig } from "./resource-list";

const mcpConfig: ResourceListConfig = {
  entity: "mcps",
  resourceType: "mcp",
  settingsKey: "mcp",
  delegationFlag: "mcpSelfManagement",
  labels: {
    add: "Add MCP server",
    attach: "Attach shared MCP",
    detachTitle: "Detach shared MCP server",
    deleteTitle: "Delete MCP server",
    noun: "MCP server",
    plural: "MCP servers",
  },
  secondLine: "url",
  emptyState: NoMcpEmptyState,
};

export const McpList = ({
  orgId,
  workspaceId,
}: {
  orgId: string;
  workspaceId?: string;
}) => (
  <ResourceList orgId={orgId} workspaceId={workspaceId} config={mcpConfig} />
);
