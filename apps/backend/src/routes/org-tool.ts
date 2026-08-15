import { Hono } from "hono";
import { getToolSets } from "../tools/index.ts";
import { db } from "../index.ts";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { listOrgScoped } from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";

// Tool sets available to an org-scoped (Shared) Agent: the statically
// registered sets (including the Sandbox set, which rebinds per Workspace at
// Chat-turn time) plus org-scoped MCPs. This mirrors the per-workspace `tool`
// route but lists org MCPs rather than workspace MCPs, so the org-surface Agent
// editor only offers references that satisfy the no-cascade rule (ADR-0007).
const orgTool = new Hono<{ Variables: Variables }>();

orgTool.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const orgId = c.req.param("orgId")!;

  const toolSetsList = getToolSets().map((toolSet) => ({
    id: toolSet.id,
    name: toolSet.name,
    category: toolSet.category,
    description: toolSet.description,
    tools:
      typeof toolSet.tools === "function"
        ? []
        : Object.entries(toolSet.tools).map(([toolId, tool]) => ({
            id: toolId,
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
