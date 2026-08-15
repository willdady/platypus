import { Hono } from "hono";
import { getToolSets } from "../tools/index.ts";
import { CORE_BUILTIN_OWNER, getToolSetPlugin } from "../plugins/registry.ts";
import { db } from "../index.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
} from "../middleware/authorization.ts";
import { listScoped } from "../services/scoped-resource.ts";
import type { Variables } from "../server.ts";

const tool = new Hono<{ Variables: Variables }>();

/** List all tool sets */
tool.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    // Get static tools. Each set is annotated with the `plugin` that
    // contributed it (ADR-0013 observability); the core-internal `sandbox` set is
    // a static registration (not a plugin contribution), so it reads as
    // core/built-in rather than a blank owner.
    const toolSetsList = getToolSets().map((toolSet) => ({
      id: toolSet.id,
      name: toolSet.name,
      category: toolSet.category,
      description: toolSet.description,
      plugin: getToolSetPlugin(toolSet.id) ?? CORE_BUILTIN_OWNER,
      tools:
        typeof toolSet.tools === "function"
          ? []
          : Object.entries(toolSet.tools).map(([toolId, tool]) => ({
              id: toolId,
              description: tool.description || "No description",
            })),
    }));

    // The MCPs this Workspace may actually use: its own, plus the Shared
    // (org-scoped) ones attached to it (ADR-0007) — the same set `GET /mcps`
    // lists, resolved through the same authority.
    const mcps = await listScoped(db, "mcp", { orgId, wsId: workspaceId });
    const mcpList = mcps.map(({ row }) => ({
      id: row.id,
      name: row.name,
      category: "MCP",
    }));

    return c.json({ results: [...toolSetsList, ...mcpList] });
  },
);

export { tool };
