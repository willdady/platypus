import { type Tool } from "ai";
import {
  convertTemperature,
  convertDistance,
  convertWeight,
  convertVolume,
} from "./math.ts";
import { getCurrentTime, convertTimezone } from "./time.ts";
import { fetchUrl } from "./fetch.ts";
import { createKanbanTools } from "./kanban.ts";
import { createTriggerTools } from "./trigger.ts";
import { createAgentManagementTools } from "./agent-management.ts";
import { createNotificationTools } from "./notification.ts";

export type ToolSetContext = {
  workspaceId: string;
  agentId: string;
  orgId: string;
  frontendUrl: string | undefined;
};

type ToolSet = {
  id: string;
  name: string;
  category: string;
  description?: string;
  tools:
    | { [toolId: string]: Tool<any, any> }
    | ((context: ToolSetContext) => Record<string, Tool>);
};

const TOOL_SETS_REGISTRY: {
  [toolSetId: string]: ToolSet;
} = {};

export const registerToolSet = (
  toolSetId: string,
  toolSet: Omit<ToolSet, "id">,
): ToolSet => {
  if (toolSetId in TOOL_SETS_REGISTRY) {
    throw new Error(
      `Tool set with id '${toolSetId}' has already been registered.`,
    );
  }
  TOOL_SETS_REGISTRY[toolSetId] = { id: toolSetId, ...toolSet };
  return TOOL_SETS_REGISTRY[toolSetId];
};

export const getToolSet = (toolSetId: string): ToolSet => {
  if (!(toolSetId in TOOL_SETS_REGISTRY)) {
    throw new Error(`Tool set with id '${toolSetId}' has not been registered.`);
  }
  return TOOL_SETS_REGISTRY[toolSetId];
};

export const getToolSets = (): typeof TOOL_SETS_REGISTRY => TOOL_SETS_REGISTRY;

// REGISTER TOOL SETS HERE!
registerToolSet("math-conversions", {
  name: "Math Conversions",
  category: "Math",
  description: "Temperature and unit conversions",
  tools: {
    convertTemperature,
    convertDistance,
    convertWeight,
    convertVolume,
  },
});

registerToolSet("time", {
  name: "Time",
  category: "Utilities",
  description:
    "Tools for getting current time and converting between timezones",
  tools: {
    getCurrentTime,
    convertTimezone,
  },
});

registerToolSet("web-fetch", {
  name: "Web Fetch",
  category: "Web",
  description: "Fetch content from URLs on the web",
  tools: {
    fetchUrl,
  },
});

registerToolSet("kanban", {
  name: "Kanban",
  category: "Productivity",
  description: "Manage kanban boards in this workspace",
  tools: ({ workspaceId, agentId, orgId, frontendUrl }) =>
    createKanbanTools(workspaceId, agentId, orgId, frontendUrl),
});

registerToolSet("triggers", {
  name: "Triggers",
  category: "Automation",
  description:
    "Manage triggers (cron schedules and event-based) including listing agents, creating, editing, and viewing triggers",
  tools: ({ workspaceId, orgId, frontendUrl }) =>
    createTriggerTools(workspaceId, orgId, frontendUrl),
});

registerToolSet("agent-management", {
  name: "Agent Management",
  category: "Productivity",
  description: "Create, update, and delete agents and skills in this workspace",
  tools: ({ workspaceId, orgId, frontendUrl }) =>
    createAgentManagementTools(workspaceId, orgId, frontendUrl),
});

registerToolSet("notifications", {
  name: "Notifications",
  category: "Communication",
  description: "Post notifications visible to users in this workspace",
  tools: ({ workspaceId, agentId }) =>
    createNotificationTools(workspaceId, agentId),
});
