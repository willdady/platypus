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
  orgCredentialsVisible,
  orgScopeOf,
  requireOrgAccess,
} from "../middleware/authorization.ts";
import {
  listOrgScoped,
  requireOrgScoped,
} from "../services/scoped-resource.ts";
import { providerReadModel } from "../services/credential-redaction.ts";
import {
  createProvider,
  deleteProvider,
  updateProvider,
} from "../services/provider-write.ts";
import { probeProviderConnection } from "../services/provider-connection.ts";
import { respond } from "../respond.ts";
import type { Variables } from "../server.ts";

const orgProvider = new Hono<{ Variables: Variables }>();

orgProvider.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", providerCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    const row = await createProvider({ kind: "organization", orgId }, data, db);
    return respond(
      c,
      providerResponseSchema,
      providerReadModel(row, { reveal: true, scope: "organization" }),
      201,
    );
  },
);

orgProvider.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const rows = await listOrgScoped(db, "provider", orgId);

  const reveal = orgCredentialsVisible(c);
  const results = rows.map((row) =>
    providerReadModel(row, { reveal, scope: "organization" }),
  );

  return respond(c, providerListResponseSchema, { results });
});

orgProvider.get("/:providerId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const providerId = c.req.param("providerId");

  const record = await requireOrgScoped(db, "provider", providerId, orgId);

  const reveal = orgCredentialsVisible(c);
  return respond(
    c,
    providerResponseSchema,
    providerReadModel(record, { reveal, scope: "organization" }),
  );
});

orgProvider.put(
  "/:providerId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", providerUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const providerId = c.req.param("providerId");
    const data = c.req.valid("json");

    const { row, aliasRepoints } = await updateProvider(
      { kind: "organization", orgId },
      providerId,
      data,
    );

    return respond(
      c,
      providerUpdateResponseSchema,
      {
        ...providerReadModel(row, { reveal: true, scope: "organization" }),
        aliasRepoints,
      },
      200,
    );
  },
);

orgProvider.delete(
  "/:providerId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const providerId = c.req.param("providerId");

    await deleteProvider({ kind: "organization", orgId }, providerId);

    return c.json({ message: "Provider deleted" });
  },
);

orgProvider.post(
  "/test",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", providerTestSchema),
  async (c) => {
    const result = await probeProviderConnection(c.req.valid("json"));
    return respond(c, providerTestResponseSchema, result);
  },
);

export { orgProvider };
