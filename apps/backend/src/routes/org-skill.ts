import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import { skillCreateSchema, skillUpdateSchema } from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import {
  listOrgScoped,
  requireOrgScoped,
} from "../services/scoped-resource.ts";
import { createSkill, deleteSkill, updateSkill } from "../services/skill.ts";
import type { Variables } from "../server.ts";

// Org-scoped Skills are Shared resources (ADR-0007): a single source of truth
// defined once at Organization scope and referenced by Workspaces through an
// Attachment. They are managed only by Org Admins on the Organization surface,
// so all mutations are org-admin-only; any member may read them.
const orgSkill = new Hono<{ Variables: Variables }>();

/** Create an org-scoped Skill (admin only) */
orgSkill.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", skillCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    // Agent associations are a workspace concern; `createSkill` ignores any
    // `agentIds` at Organization scope. A duplicate name surfaces as a Postgres
    // unique violation, mapped to 409 by the central onError (ADR-0010).
    const row = await createSkill({ kind: "organization", orgId }, data);
    return c.json(row, 201);
  },
);

/** List org-scoped Skills */
orgSkill.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const results = await listOrgScoped(db, "skill", orgId);
  return c.json({ results });
});

/** Get an org-scoped Skill by ID */
orgSkill.get("/:skillId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const skillId = c.req.param("skillId");
  const record = await requireOrgScoped(db, "skill", skillId, orgId);
  return c.json(record);
});

/** Update an org-scoped Skill by ID (admin only) */
orgSkill.put(
  "/:skillId",
  requireAuth,
  requireOrgAccess(["admin"]),
  sValidator("json", skillUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const skillId = c.req.param("skillId");
    const data = c.req.valid("json");

    // `updateSkill` throws NotFound (→404) via requireOrgScoped when the Skill
    // is not a Shared resource of this Organization, before the write ever
    // runs (#605). Agent associations are a workspace concern and are ignored. A
    // duplicate name surfaces as a Postgres unique violation, mapped to 409 by
    // the central onError (ADR-0010).
    const row = await updateSkill(
      { kind: "organization", orgId },
      skillId,
      data,
    );
    return c.json(row, 200);
  },
);

/** Delete an org-scoped Skill by ID (admin only) */
orgSkill.delete(
  "/:skillId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const skillId = c.req.param("skillId");

    // `deleteSkill` throws ConflictError (→409, ADR-0007/0008) while an
    // Attachment or Blueprint still references the Skill, and NotFound (→404)
    // when it is not visible here.
    await deleteSkill({ kind: "organization", orgId }, skillId);

    return c.json({ message: "Skill deleted" });
  },
);

export { orgSkill };
