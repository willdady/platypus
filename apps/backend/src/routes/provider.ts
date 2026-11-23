import { Hono } from "hono";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import {
  providerCreateSchema,
  providerListResponseSchema,
  providerResponseSchema,
  providerTestResponseSchema,
  providerTestSchema,
  providerUpdateResponseSchema,
  providerUpdateSchema,
} from "@platypus/schemas";
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
import { probeProviderConnection } from "../services/provider-connection.ts";
import { respond } from "../respond.ts";
import type { Variables } from "../server.ts";

const provider = new Hono<{ Variables: Variables }>();

provider.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  validate("json", providerCreateSchema),
  async (c) => {
    const data = c.req.valid("json");
    const ctx = workspaceScopeOf(c);
    const row = await createProvider({ kind: "workspace", ctx }, data, db);
    return respond(
      c,
      providerResponseSchema,
      providerReadModel(row, { reveal: true, scope: "workspace" }),
      201,
    );
  },
);

provider.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scoped = await listScoped(db, "provider", workspaceScopeOf(c));
    const reveal = await workspaceCredentialsVisible(c, "provider");
    const results = scoped.map(({ row, scope }) =>
      providerReadModel(row, {
        reveal: reveal && scope === "workspace",
        scope,
      }),
    );
    return respond(c, providerListResponseSchema, { results });
  },
);

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
    const reveal = await workspaceCredentialsVisible(c, "provider");
    return respond(
      c,
      providerResponseSchema,
      providerReadModel(found.row, {
        reveal: reveal && found.scope === "workspace",
        scope: found.scope,
      }),
    );
  },
);

provider.put(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  validate("json", providerUpdateSchema),
  async (c) => {
    const ctx = workspaceScopeOf(c);
    const providerId = c.req.param("providerId");
    const data = c.req.valid("json");

    const { row, aliasRepoints } = await updateProvider(
      { kind: "workspace", ctx },
      providerId,
      data,
    );

    return respond(
      c,
      providerUpdateResponseSchema,
      {
        ...providerReadModel(row, { reveal: true, scope: "workspace" }),
        aliasRepoints,
      },
      200,
    );
  },
);

provider.delete(
  "/:providerId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  async (c) => {
    const ctx = workspaceScopeOf(c);
    const providerId = c.req.param("providerId");

    await deleteProvider({ kind: "workspace", ctx }, providerId);

    return c.json({ message: "Provider deleted" });
  },
);

provider.post(
  "/test",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceConfigAccess("providerSelfManagement"),
  validate("json", providerTestSchema),
  async (c) => {
    const result = await probeProviderConnection(c.req.valid("json"));
    return respond(c, providerTestResponseSchema, result);
  },
);

export { provider };
