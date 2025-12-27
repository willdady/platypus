import { Hono } from "hono";
import { getToolSets } from "../tools/index.ts";
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
  requireWorkspaceAccess(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    // Get static tools
    const toolSetsList = Object.entries(getToolSets()).map(([id, toolSet]) => ({
      id,
      name: toolSet.name,
      category: toolSet.category,
      description: toolSet.description,
      tools: Object.entries(toolSet.tools).map(([toolId, tool]) => ({
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
