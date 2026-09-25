import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { requireOrgAccess } from "../middleware/authorization.ts";
import { getSandboxBackends } from "../sandbox/index.ts";
import { readAllowedDockerNetworks } from "../plugins/docker/backend.ts";
import {
  getPluginConfig,
  getSandboxBackendPlugin,
} from "../plugins/registry.ts";
import type { Variables } from "../server.ts";

// Manifest name of the core Docker plugin — the key its boot-resolved config
// (the network allowlist) is stored under in the plugin registry (ADR-0013).
const DOCKER_PLUGIN = "@platypus/docker";

const sandboxBackends = new Hono<{ Variables: Variables }>();

// The Sandbox backends registered in this process. Returns metadata only (no
// Zod schemas); the frontend renders forms per known backend type for v1. Each
// entry is annotated with the `plugin` that contributed it (ADR-0013
// observability); `null` when the id belongs to no loaded plugin.
//
// Org-scoped for the same reason as `GET /web-backends`: the list is
// deployment-wide, and a Sandbox is configured while creating a Workspace, before
// there is a workspace to scope the read to.
sandboxBackends.get("/", requireAuth, requireOrgAccess(), (c) => {
  const results = getSandboxBackends().map((r) => ({
    backend: r.backend,
    name: r.name,
    plugin: getSandboxBackendPlugin(r.backend) ?? null,
  }));
  return c.json({ results });
});

// Operator-declared Docker network allowlist (ADR-0005) for the admin
// multi-select. Admin-only — a non-admin owner has no business enumerating the
// host's network topology.
sandboxBackends.get(
  "/networks",
  requireAuth,
  requireOrgAccess(["admin"]),
  (c) => {
    return c.json({
      results: readAllowedDockerNetworks(getPluginConfig(DOCKER_PLUGIN)),
    });
  },
);

export { sandboxBackends };
