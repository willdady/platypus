import { Hono } from "hono";
import { validate } from "../validate.ts";
import {
  blueprintCreateSchema,
  blueprintUpdateSchema,
  blueprintApplySchema,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import {
  applyBlueprint,
  createBlueprint,
  deleteBlueprint,
  getBlueprint,
  listBlueprints,
  updateBlueprint,
} from "../services/blueprint.ts";

/**
 * The Organization surface over the Blueprint module (`services/blueprint.ts`,
 * ADR-0008). All management — and applying — is Org-Admin-only; each handler
 * authorizes, calls the module and returns its result, and the module's typed
 * failures are mapped to a status by `app.onError` (ADR-0010).
 */
const orgBlueprint = new Hono<{ Variables: Variables }>();

/** Create a Blueprint (admin only) */
orgBlueprint.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", blueprintCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json(await createBlueprint(orgId, c.req.valid("json")), 201);
  },
);

/** List Blueprints, each with its items (admin only) */
orgBlueprint.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const { orgId } = orgScopeOf(c);
  return c.json({ results: await listBlueprints(orgId) });
});

/** Get a Blueprint by ID, with its items (admin only) */
orgBlueprint.get(
  "/:blueprintId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json(await getBlueprint(c.req.param("blueprintId"), orgId));
  },
);

/** Update a Blueprint by ID (admin only) — replaces its item set */
orgBlueprint.put(
  "/:blueprintId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", blueprintUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const record = await updateBlueprint(
      c.req.param("blueprintId"),
      orgId,
      c.req.valid("json"),
    );
    return c.json(record, 200);
  },
);

/** Delete a Blueprint by ID (admin only) — items cascade */
orgBlueprint.delete(
  "/:blueprintId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    await deleteBlueprint(c.req.param("blueprintId"), orgId);
    return c.json({ message: "Blueprint deleted" });
  },
);

/**
 * Apply a Blueprint to an existing Workspace (admin only). The macro creates the
 * Tier 1 Attachments for the Blueprint's current items and stamps its Tier 2
 * pointer-settings onto the Workspace. It is additive and idempotent on Tier 1
 * (re-applying, or applying a resource already attached, is a no-op) and
 * last-write-wins on Tier 2 (ADR-0008). Ad-hoc apply stays single-Blueprint;
 * the ordered set lives only on invitations (ADR-0009).
 */
orgBlueprint.post(
  "/:blueprintId/apply",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", blueprintApplySchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const { workspaceId } = c.req.valid("json");
    const result = await applyBlueprint(
      c.req.param("blueprintId"),
      orgId,
      workspaceId,
    );
    return c.json({ workspaceId, ...result }, 200);
  },
);

export { orgBlueprint };
