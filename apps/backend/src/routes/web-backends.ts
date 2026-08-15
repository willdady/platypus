import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { getWebBackendPlugin } from "../plugins/registry.ts";
import { getWebBackends } from "../web-backends/index.ts";
import type { Variables } from "../server.ts";

const webBackends = new Hono<{ Variables: Variables }>();

// Read-only catalog of the Web-search backends registered in this process
// (ADR-0014), for the `searchSource` selector on the Provider form. Metadata only:
// the discriminator to store, a display name, and the `plugin` that contributed
// it (`null` when the id belongs to no loaded plugin) — the same annotation
// `GET /backends` carries for sandboxes.
//
// Mounted org-scoped rather than under a workspace, unlike sandbox's
// `GET /backends`: a sandbox *is* a workspace resource, but Providers exist in
// both scopes (ADR-0007) and one `ProviderForm` serves both, so a
// workspace-scoped catalog would be unreachable when an Org Admin edits a Shared
// Provider — the case the selector matters most for. The precedent is
// `GET /plugins`: the orgId scopes *access*, not the data. A web backend arrives
// via `PLATYPUS_PLUGINS` in the backend environment and is registered at boot
// into a module-level registry; there is no table behind it, so no org or
// workspace can hold a different list.
//
// Read posture is `requireOrgAccess()`, matching `GET /backends` rather than
// `GET /plugins`' admin-only gate: a workspace-scoped Provider is editable by a
// non-admin Workspace Owner when `providerSelfManagement` is set, and that owner
// would otherwise get an empty dropdown with no explanation.
webBackends.get("/", requireAuth, requireOrgAccess(), (c) => {
  const results = getWebBackends().map((r) => ({
    backend: r.backend,
    name: r.name,
    plugin: getWebBackendPlugin(r.backend) ?? null,
  }));
  return c.json({ results });
});

export { webBackends };
