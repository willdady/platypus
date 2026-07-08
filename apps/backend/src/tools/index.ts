import { type Tool } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../index.ts";
import { sandbox as sandboxTable } from "../db/schema.ts";
import { getSandboxBackend } from "../sandbox/index.ts";
import { createSandboxTools } from "../sandbox/tools.ts";
import { logger } from "../logger.ts";

// The Extension-point surface lives in the published SDK; re-export the context
// type so core's internal callers keep importing it from here.
export type { ToolSetContext } from "@platypuschat/plugin-sdk";
import type { ToolSetContext } from "@platypuschat/plugin-sdk";

type ToolSet = {
  id: string;
  name: string;
  category: string;
  description?: string;
  tools:
    | { [toolId: string]: Tool }
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
// Note: the native Tool sets now ship as core plugins loaded via the plugin
// loader from `PLATYPUS_PLUGINS` (see ADR-0013) — `math-conversions`/`time` as
// `@platypus/tools-basic`, `web-fetch` as `@platypus/web-fetch`, and the
// Platypus-domain sets (kanban, dashboards, triggers, agent-discovery,
// skill-management, agent-management, notifications, memory) as
// `@platypus/tools-platform`. Their factories live in `./*.ts`; the manifests
// live under `apps/backend/src/plugins/`.
//
// The `sandbox` Tool set below is the lone exception: it is the consumer side of
// the Sandbox-backend extension point (ADR-0002) rather than a native Tool set,
// so it stays a core-internal static registration here. It resolves at chat-turn
// time: load the Workspace's sandbox row, look up the registered adapter,
// validate config/credentials, then build the five AI SDK Tools. Missing-row,
// unregistered-backend, and
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
