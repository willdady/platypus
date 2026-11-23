import type { PlatypusPlugin } from "@platypuschat/plugin-sdk";
import { PLUGIN_API_VERSION } from "@platypuschat/plugin-sdk";
import { createKanbanTools } from "../../tools/kanban.ts";
import { createKanbanBoardTools } from "../../tools/kanban-boards.ts";
import { createTriggerTools } from "../../tools/trigger.ts";
import { createAgentDiscoveryTools } from "../../tools/agent-discovery.ts";
import { createSkillManagementTools } from "../../tools/skill-management.ts";
import { createAgentManagementTools } from "../../tools/agent-management.ts";
import { createNotificationTools } from "../../tools/notification.ts";
import { createMemoryTools } from "../../tools/memory.ts";
import { createChatTools } from "../../tools/chats.ts";
import { createArtifactTools } from "../../tools/artifacts.ts";

export const plugin: PlatypusPlugin = {
  name: "@platypus/tools-platform",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  contributes: {
    toolSets: [
      {
        id: "kanban",
        name: "Kanban Cards",
        category: "Kanban",
        description:
          "Read kanban boards and manage their cards and comments in this workspace",
        tools: ({ workspaceId, agentId, orgId, frontendUrl }) =>
          createKanbanTools(workspaceId, agentId, orgId, frontendUrl),
      },
      {
        id: "kanban-boards",
        name: "Kanban Boards",
        category: "Kanban",
        description:
          "Create, edit and delete kanban boards and their columns in this workspace",
        tools: ({ workspaceId, orgId, frontendUrl }) =>
          createKanbanBoardTools(workspaceId, orgId, frontendUrl),
      },
      {
        id: "triggers",
        name: "Triggers",
        category: "Automation",
        description:
          "Manage triggers (cron schedules, one-off runs and event-based) including listing agents, creating, editing, and viewing triggers, and getting the current time",
        tools: ({ workspaceId, orgId, frontendUrl, timezone }) =>
          createTriggerTools(workspaceId, orgId, frontendUrl, timezone),
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
        description:
          "Post notifications the Workspace Owner reads in the in-app bell, then list, edit or delete its own",
        tools: ({ workspaceId, agentId, orgId }) =>
          createNotificationTools(workspaceId, agentId, orgId),
      },
      {
        id: "chats",
        name: "Chats",
        category: "Productivity",
        description:
          "Read-only tools for listing the workspace's chats and reading a chat's transcript",
        tools: ({ orgId, workspaceId, sessionId }) =>
          createChatTools(orgId, workspaceId, sessionId),
      },
      {
        id: "artifacts",
        name: "Artifacts",
        category: "Productivity",
        description:
          "Create, change, read and list standalone, versioned content — documents, code, Mermaid diagrams, HTML pages and SVG images — in this workspace",
        tools: ({ workspaceId, sessionId }) =>
          createArtifactTools(workspaceId, sessionId),
      },
      {
        id: "memory",
        name: "Memory",
        category: "Memory",
        description: "Look up memories from past conversations",
        tools: ({ workspaceId, userId, sessionId }) =>
          createMemoryTools(workspaceId, userId, sessionId),
      },
    ],
  },
};
