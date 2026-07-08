import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { createKanbanTools } from "../../tools/kanban.ts";
import { createDashboardTools } from "../../tools/dashboard.ts";
import { createTriggerTools } from "../../tools/trigger.ts";
import { createAgentDiscoveryTools } from "../../tools/agent-discovery.ts";
import { createSkillManagementTools } from "../../tools/skill-management.ts";
import { createAgentManagementTools } from "../../tools/agent-management.ts";
import { createNotificationTools } from "../../tools/notification.ts";
import { createMemoryTools } from "../../tools/memory.ts";

// Core plugin: the Platypus-domain Tool sets — the ones that touch Platypus's
// own data (kanban boards, dashboards, triggers, memory, notifications, agent
// discovery/management, skill management). Grouped by cohesion per ADR-0013: no
// single one of these is a capability an Operator would deny in isolation (that
// carve-out is reserved for @platypus/web-fetch's egress and @platypus/docker's
// infra). Every id stays unprefixed (core), so persisted `agent.toolSetIds`
// references keep resolving unchanged.
//
// Each Tool set uses the factory form — its tools resolve at Chat-turn time from
// the ToolSetContext (Workspace/Agent/Org scope) core supplies.
export const plugin: PlatypusPlugin = {
  name: "@platypus/tools-platform",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: {
    toolSets: [
      {
        id: "kanban",
        name: "Kanban",
        category: "Productivity",
        description: "Manage kanban boards in this workspace",
        tools: ({ workspaceId, agentId, orgId, frontendUrl }) =>
          createKanbanTools(workspaceId, agentId, orgId, frontendUrl),
      },
      {
        id: "dashboards",
        name: "Dashboards",
        category: "Productivity",
        description:
          "List dashboards and widgets, and update widget data in this workspace",
        tools: ({ workspaceId }) => createDashboardTools(workspaceId),
      },
      {
        id: "triggers",
        name: "Triggers",
        category: "Automation",
        description:
          "Manage triggers (cron schedules and event-based) including listing agents, creating, editing, and viewing triggers",
        tools: ({ workspaceId, orgId, frontendUrl }) =>
          createTriggerTools(workspaceId, orgId, frontendUrl),
      },
      {
        id: "agent-discovery",
        name: "Agent Discovery",
        category: "Productivity",
        description:
          "Read-only tools for discovering agents, providers, and tool sets in this workspace",
        tools: ({ workspaceId, orgId, frontendUrl }) =>
          createAgentDiscoveryTools(workspaceId, orgId, frontendUrl),
      },
      {
        id: "skill-management",
        name: "Skill Management",
        category: "Productivity",
        description:
          "List, create, update, and delete skills in this workspace",
        tools: ({ workspaceId, orgId, frontendUrl }) =>
          createSkillManagementTools(workspaceId, orgId, frontendUrl),
      },
      {
        id: "agent-management",
        name: "Agent Management",
        category: "Productivity",
        description: "Create, update, and delete agents in this workspace",
        tools: ({ workspaceId, orgId, frontendUrl }) =>
          createAgentManagementTools(workspaceId, orgId, frontendUrl),
      },
      {
        id: "notifications",
        name: "Notifications",
        category: "Communication",
        description: "Post notifications visible to users in this workspace",
        tools: ({ workspaceId, agentId, orgId }) =>
          createNotificationTools(workspaceId, agentId, orgId),
      },
      {
        id: "memory",
        name: "Memory",
        category: "Memory",
        description: "Search and retrieve memories from past conversations",
        tools: ({ workspaceId, userId }) =>
          createMemoryTools(workspaceId, userId),
      },
    ],
  },
};
