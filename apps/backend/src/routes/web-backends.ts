import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { getWebBackendPlugin } from "../plugins/registry.ts";
import { getWebBackends } from "../web-backends/index.ts";
import type { Variables } from "../server.ts";

const webBackends = new Hono<{ Variables: Variables }>();

webBackends.get("/", requireAuth, requireOrgAccess(), (c) => {
  const results = getWebBackends().map((r) => ({
    backend: r.backend,
    name: r.name,
    plugin: getWebBackendPlugin(r.backend) ?? null,
  }));
  return c.json({ results });
});

export { webBackends };
