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

const orgBlueprint = new Hono<{ Variables: Variables }>();

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

orgBlueprint.get("/", requireAuth, requireOrgAccess(["admin"]), async (c) => {
  const { orgId } = orgScopeOf(c);
  return c.json({ results: await listBlueprints(orgId) });
});

orgBlueprint.get(
  "/:blueprintId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json(await getBlueprint(c.req.param("blueprintId"), orgId));
  },
);

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
