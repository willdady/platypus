import { Hono } from "hono";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import { providerCreateSchema, providerUpdateSchema } from "@platypus/schemas";
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
import type { Variables } from "../server.ts";

const orgProvider = new Hono<{ Variables: Variables }>();

/** Create a new organization provider (admin only) */
orgProvider.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", providerCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    const row = await createProvider({ kind: "organization", orgId }, data);
    return c.json(row, 201);
  },
);

/** List all organization providers */
orgProvider.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const rows = await listOrgScoped(db, "provider", orgId);

  // This route admits any Organization member — a Shared Provider has to be
  // listable to be selected. Only an Org Admin sees its credentials (ADR-0006).
  const reveal = orgCredentialsVisible(c);
  const results = rows.map((row) => providerReadModel(row, { reveal }));

  return c.json({ results });
});

/** Get an organization provider by ID */
orgProvider.get("/:providerId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const providerId = c.req.param("providerId");

  const record = await requireOrgScoped(db, "provider", providerId, orgId);

  // See the list route: credentials are Org-Admin-only (ADR-0006).
  const reveal = orgCredentialsVisible(c);
  return c.json(providerReadModel(record, { reveal }));
});

/** Update an organization provider by ID (admin only) */
orgProvider.put(
  "/:providerId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", providerUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const providerId = c.req.param("providerId");
    const data = c.req.valid("json");

    // `updateProvider` now checks the Provider is a Shared resource of this
    // Organization before touching embeddings (#605) — this route used to
    // skip that check and discover a missing row only when the `UPDATE`
    // matched nothing.
    const { row, aliasRepoints } = await updateProvider(
      { kind: "organization", orgId },
      providerId,
      data,
    );

    return c.json({ ...row, aliasRepoints }, 200);
  },
);

/** Delete an organization provider by ID (admin only) */
orgProvider.delete(
  "/:providerId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const providerId = c.req.param("providerId");

    // `deleteProvider` throws ConflictError (→409) while an Attachment
    // (ADR-0007) or Blueprint (ADR-0008) still references the Provider, then
    // NotFoundError (→404) when the delete matches no row.
    await deleteProvider({ kind: "organization", orgId }, providerId);

    return c.json({ message: "Provider deleted" });
  },
);

export { orgProvider };
