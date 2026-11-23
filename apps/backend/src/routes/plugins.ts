import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { getLoadedPlugins } from "../plugins/registry.ts";
import type { Variables } from "../server.ts";

const plugins = new Hono<{ Variables: Variables }>();

plugins.get("/", requireAuth, requireOrgAccess(["admin"]), (c) => {
  const results = getLoadedPlugins().map((p) => ({
    name: p.name,
    version: p.version,
    origin: p.origin,
    contributions: {
      toolSets: p.toolSetIds,
      sandboxBackends: p.sandboxBackendIds,
      webBackends: p.webBackendIds,
      toolGates: p.toolGateIds,
    },
  }));
  return c.json({ results });
});

export { plugins };
