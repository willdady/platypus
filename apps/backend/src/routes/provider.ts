import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import { providerCreateSchema, providerUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess,
  workspaceCredentialsVisible,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { providerReadModel } from "../services/credential-redaction.ts";
import { listScoped, requireScoped } from "../services/scoped-resource.ts";
import {
  createProvider,
  deleteProvider,
  updateProvider,
} from "../services/provider-write.ts";
import type { Variables } from "../server.ts";

const provider = new Hono<{ Variables: Variables }>();

/**
 * Create a workspace-scoped provider. Org-admin by default; a workspace owner
 * may create one only when the workspace's `providerSelfManagement` flag is set
 * (ADR-0006).
 */
provider.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  sValidator("json", providerCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const ctx = workspaceScopeOf(c);
    // The scope comes from the route, never the body — as it does for Agents
    // and Skills. Spreading the body let a caller name another Workspace, or
    // set `organizationId` and mint a Shared Provider from the Workspace
    // surface, which only an Org Admin may do (ADR-0006, ADR-0007).
    const row = await createProvider({ kind: "workspace", ctx }, data);
    return c.json(row, 201);
  },
);

/** List providers visible in this workspace (workspace-scoped + attached org-scoped) */
provider.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scoped = await listScoped(db, "provider", workspaceScopeOf(c));
    // Credentials are revealed only to a caller who may manage this Provider
    // (ADR-0006) — the same rule the write routes reject on. The rows themselves
    // still list, because selecting a Provider on an Agent or Chat does not
    // require self-management.
    // A Shared row is configured only by an Org Admin on the Organization
    // surface (ADR-0007), so the delegation never reveals its credentials.
    const reveal = await workspaceCredentialsVisible(c, "provider");
    const results = scoped.map(({ row, scope }) =>
      providerReadModel(row, {
        reveal: reveal && scope === "workspace",
        scope,
      }),
    );
    return c.json({ results });
  },
);

/** Get a provider by ID (workspace-scoped, or attached org-scoped) */
provider.get(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const providerId = c.req.param("providerId");

    const found = await requireScoped(
      db,
      "provider",
      providerId,
      workspaceScopeOf(c),
    );
    // See the list route: redacted unless this caller may manage the Provider.
    const reveal = await workspaceCredentialsVisible(c, "provider");
    return c.json(
      providerReadModel(found.row, {
        reveal: reveal && found.scope === "workspace",
        scope: found.scope,
      }),
    );
  },
);

/** Update a provider by ID (org-admin, or owner when delegated — ADR-0006) */
provider.put(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  sValidator("json", providerUpdateSchema),
  async (c) => {
    const ctx = workspaceScopeOf(c);
    const providerId = c.req.param("providerId");
    const data = c.req.valid("json");

    // The five-step save ordering — dedupe, embedding invalidation, alias
    // snapshot, write, de-migration — lives in the write model; here it's the
    // Workspace scope's "not visible → 404, Shared → 403" rule (ADR-0007) that
    // matters (`updateProvider` enforces it via `requireWorkspaceMutable`).
    const { row, aliasRepoints } = await updateProvider(
      { kind: "workspace", ctx },
      providerId,
      data,
    );

    return c.json({ ...row, aliasRepoints }, 200);
  },
);

/** Delete a provider by ID (org-admin, or owner when delegated — ADR-0006) */
provider.delete(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  async (c) => {
    const ctx = workspaceScopeOf(c);
    const providerId = c.req.param("providerId");

    // A Shared Provider is deleted only from the Organization surface
    // (ADR-0007): `deleteProvider` throws NotFound (→404) when the Provider is
    // not visible here, then Locked (→403) when it is org-scoped.
    await deleteProvider({ kind: "workspace", ctx }, providerId);

    return c.json({ message: "Provider deleted" });
  },
);

export { provider };
