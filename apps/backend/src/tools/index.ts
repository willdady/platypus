import { type Tool } from "ai";
import { eq } from "drizzle-orm";
import {
  convertTemperature,
  convertDistance,
  convertWeight,
  convertVolume,
} from "./math.ts";
import { getCurrentTime, convertTimezone } from "./time.ts";
import { fetchUrl } from "./fetch.ts";
import { createKanbanTools } from "./kanban.ts";
import { createDashboardTools } from "./dashboard.ts";
import { createTriggerTools } from "./trigger.ts";
import { createAgentDiscoveryTools } from "./agent-discovery.ts";
import { createSkillManagementTools } from "./skill-management.ts";
import { createAgentManagementTools } from "./agent-management.ts";
import { createNotificationTools } from "./notification.ts";
import { createMemoryTools } from "./memory.ts";
import { db } from "../index.ts";
import { sandbox as sandboxTable } from "../db/schema.ts";
import { getSandboxBackend } from "../sandbox/index.ts";
import { createSandboxTools } from "../sandbox/tools.ts";
import { logger } from "../logger.ts";

export type ToolSetContext = {
  workspaceId: string;
  agentId: string;
  orgId: string;
  frontendUrl: string | undefined;
  userId: string;
};

type ToolSet = {
  id: string;
  name: string;
  category: string;
  description?: string;
  tools:
    | { [toolId: string]: Tool<any, any> }
    | ((
        context: ToolSetContext,
      ) => Record<string, Tool> | Promise<Record<string, Tool>>);
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

// Tool set ID constants for referencing registered tool sets by name
export const MEMORY_TOOLSET_ID = "memory";

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

registerToolSet("dashboards", {
  name: "Dashboards",
  category: "Productivity",
  description:
    "List dashboards and widgets, and update widget data in this workspace",
  tools: ({ workspaceId }) => createDashboardTools(workspaceId),
});

registerToolSet("triggers", {
  name: "Triggers",
  category: "Automation",
  description:
    "Manage triggers (cron schedules and event-based) including listing agents, creating, editing, and viewing triggers",
  tools: ({ workspaceId, orgId, frontendUrl }) =>
    createTriggerTools(workspaceId, orgId, frontendUrl),
});

registerToolSet("agent-discovery", {
  name: "Agent Discovery",
  category: "Productivity",
  description:
    "Read-only tools for discovering agents, providers, and tool sets in this workspace",
  tools: ({ workspaceId, orgId, frontendUrl }) =>
    createAgentDiscoveryTools(workspaceId, orgId, frontendUrl),
});

registerToolSet("skill-management", {
  name: "Skill Management",
  category: "Productivity",
  description: "List, create, update, and delete skills in this workspace",
  tools: ({ workspaceId, orgId, frontendUrl }) =>
    createSkillManagementTools(workspaceId, orgId, frontendUrl),
});

registerToolSet("agent-management", {
  name: "Agent Management",
  category: "Productivity",
  description: "Create, update, and delete agents in this workspace",
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

registerToolSet("memory", {
  name: "Memory",
  category: "Memory",
  description: "Search and retrieve memories from past conversations",
  tools: ({ workspaceId, userId }) => createMemoryTools(workspaceId, userId),
});

// The sandbox tool set resolves at chat-turn time: load the Workspace's
// sandbox row, look up the registered adapter, validate config/credentials,
// then build the five AI SDK Tools. Missing-row, unregistered-backend, and
// validation failures all degrade gracefully to "no tools this turn" (with a
// warning log). See ADR-0001 / ADR-0002.
export const SANDBOX_TOOLSET_ID = "sandbox";

registerToolSet(SANDBOX_TOOLSET_ID, {
  name: "Sandbox",
  category: "Sandbox",
  description:
    "Shell and filesystem access inside the workspace's configured sandbox",
  tools: async ({ workspaceId, orgId, userId }) => {
    const rows = await db
      .select()
      .from(sandboxTable)
      .where(eq(sandboxTable.workspaceId, workspaceId))
      .limit(1);
    if (rows.length === 0) return {};

    const row = rows[0];
    const registration = getSandboxBackend(row.backend);
    if (!registration) {
      logger.warn(
        { backend: row.backend, sandboxId: row.id },
        "Sandbox backend not registered; skipping sandbox tools for this turn",
      );
      return {};
    }

    const configResult = registration.configSchema.safeParse(row.config ?? {});
    if (!configResult.success) {
      logger.warn(
        { sandboxId: row.id, issues: configResult.error.issues },
        "Sandbox config failed adapter validation; skipping sandbox tools",
      );
      return {};
    }

    const credentialsResult = registration.credentialsSchema.safeParse(
      row.credentials ?? {},
    );
    if (!credentialsResult.success) {
      logger.warn(
        { sandboxId: row.id, issues: credentialsResult.error.issues },
        "Sandbox credentials failed adapter validation; skipping sandbox tools",
      );
      return {};
    }

    const backend = registration.create(
      configResult.data,
      credentialsResult.data,
    );
    // Two-tier env (ADR-0004 amendment, ADR-0006): adminEnv wins over userEnv.
    // The combined map is then merged over the model-provided input.env inside
    // createSandboxTools (workspace wins), giving the full precedence order
    // adminEnv ▸ userEnv ▸ input.env.
    const workspaceEnv = { ...(row.userEnv ?? {}), ...(row.adminEnv ?? {}) };
    return createSandboxTools(
      backend,
      { orgId, workspaceId, userId },
      workspaceEnv,
    );
  },
});
