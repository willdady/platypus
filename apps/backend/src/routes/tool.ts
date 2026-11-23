import { Hono } from "hono";
import { getToolSets } from "../tools/index.ts";
import { CORE_BUILTIN_OWNER, getToolSetPlugin } from "../plugins/registry.ts";
import { db } from "../index.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { listScoped } from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";

const tool = new Hono<{ Variables: Variables }>();

tool.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const toolSetsList = getToolSets().map((toolSet) => ({
      id: toolSet.id,
      name: toolSet.name,
      category: toolSet.category,
      description: toolSet.description,
      plugin: getToolSetPlugin(toolSet.id) ?? CORE_BUILTIN_OWNER,
      tools: Object.entries(toolSet.staticTools ?? {}).map(
        ([toolId, tool]) => ({
          id: toolId,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
          description: tool.description || "No description",
        }),
      ),
    }));

    const mcps = await listScoped(db, "mcp", workspaceScopeOf(c));
    const mcpList = mcps.map(({ row }) => ({
      id: row.id,
      name: row.name,
      category: "MCP",
    }));

    return c.json({ results: [...toolSetsList, ...mcpList] });
  },
);

export { tool };
