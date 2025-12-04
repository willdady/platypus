import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { getToolSets } from "../tools/index.ts";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import { eq } from "drizzle-orm";

const tool = new Hono();

/** List all tool sets */
tool.get(
  "/",
  sValidator(
    "query",
    z.object({
      workspaceId: z.string(),
    }),
  ),
  async (c) => {
    const { workspaceId } = c.req.valid("query");
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
