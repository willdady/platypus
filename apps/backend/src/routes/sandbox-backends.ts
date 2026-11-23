import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { getSandboxBackends } from "../sandbox/index.ts";
import { readAllowedDockerNetworks } from "../plugins/docker/backend.ts";
import type { DockerPluginConfig } from "../plugins/docker/backend.ts";
import {
  getPluginConfig,
  getSandboxBackendPlugin,
} from "../plugins/registry.ts";
import type { Variables } from "../server.ts";

const DOCKER_PLUGIN = "@platypus/docker";

const sandboxBackends = new Hono<{ Variables: Variables }>();

sandboxBackends.get("/", requireAuth, requireOrgAccess(), (c) => {
  const results = getSandboxBackends().map((r) => ({
    backend: r.backend,
    name: r.name,
    plugin: getSandboxBackendPlugin(r.backend) ?? null,
  }));
  return c.json({ results });
});

sandboxBackends.get(
  "/networks",
  requireAuth,
  requireOrgAccess(["admin"]),
  (c) => {
    return c.json({
      results: readAllowedDockerNetworks(
        getPluginConfig<DockerPluginConfig>(DOCKER_PLUGIN),
      ),
    });
  },
);

export { sandboxBackends };
