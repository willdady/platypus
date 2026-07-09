import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { getLoadedPlugins } from "../plugins/registry.ts";
import type { Variables } from "../server.ts";

const plugins = new Hono<{ Variables: Variables }>();

// Read-only catalog of the plugins loaded at boot (ADR-0013): name, version,
// origin, and the contributions each fills. There is deliberately no enable/
// disable mutation here — enablement is deploy-time list membership
// (`PLATYPUS_PLUGINS`), Operator-owned, not an API action.
//
// This backs the read-only Org-Admin "Installed plugins" view (#295), so it is
// gated to Org Admins. Plugins are a deployment-wide concern — the payload is
// identical for every org; the orgId in the path scopes *access*, not the data
// (the same pattern as `GET /backends` and the Tools listing, which expose
// process-wide registries under an org/workspace path). Super admins bypass.
plugins.get("/", requireAuth, requireOrgAccess(["admin"]), (c) => {
  const results = getLoadedPlugins().map((p) => ({
    name: p.name,
    version: p.version,
    origin: p.origin,
    contributions: {
      toolSets: p.toolSetIds,
      sandboxBackends: p.sandboxBackendIds,
    },
  }));
  return c.json({ results });
});

export { plugins };
