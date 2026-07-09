import { Hono } from "hono";
import { getToolSets } from "../tools/index.ts";
import { CORE_BUILTIN_OWNER, getToolSetPlugin } from "../plugins/registry.ts";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";

const tool = new Hono<{ Variables: Variables }>();

/** List all tool sets */
tool.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    // Get static tools. Each set is annotated with the `plugin` that
    // contributed it (ADR-0013 observability); the core-internal `sandbox` set is
    // a static registration (not a plugin contribution), so it reads as
    // core/built-in rather than a blank owner.
    const toolSetsList = Object.entries(getToolSets()).map(([id, toolSet]) => ({
      id,
      name: toolSet.name,
      category: toolSet.category,
      description: toolSet.description,
      plugin: getToolSetPlugin(id) ?? CORE_BUILTIN_OWNER,
      tools:
        typeof toolSet.tools === "function"
          ? []
          : Object.entries(toolSet.tools).map(([toolId, tool]) => ({
              id: toolId,
              description: tool.description || "No description",
            })),
    }));

    // Get MCPs
    const mcps = await db
      .select()
      .from(mcpTable)
      .where(eq(mcpTable.workspaceId, workspaceId));
    const mcpList = mcps.map((mcp) => ({
      id: mcp.id,
      name: mcp.name,
      category: "MCP",
    }));

    return c.json({ results: [...toolSetsList, ...mcpList] });
  },
);

export { tool };
