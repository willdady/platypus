import { Hono } from "hono";
import { getToolSets } from "../tools/index.ts";
import { db } from "../index.ts";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import { listOrgScoped } from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";

const orgTool = new Hono<{ Variables: Variables }>();

orgTool.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);

  const toolSetsList = getToolSets().map((toolSet) => ({
    id: toolSet.id,
    name: toolSet.name,
    category: toolSet.category,
    description: toolSet.description,
    tools: Object.entries(toolSet.staticTools ?? {}).map(([toolId, tool]) => ({
      id: toolId,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty string falls back too
      description: tool.description || "No description",
    })),
  }));

  const mcps = await listOrgScoped(db, "mcp", orgId);
  const mcpList = mcps.map((mcp) => ({
    id: mcp.id,
    name: mcp.name,
    category: "MCP",
  }));

  return c.json({ results: [...toolSetsList, ...mcpList] });
});

export { orgTool };
