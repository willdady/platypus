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
import {
  exportSkillBundle,
  importSkillBundle,
  downloadSkillFile,
  replaceSkillBundle,
  SKILL_FILE_CONTENT_TYPE,
  skillFilesForApi,
} from "../services/skill-bundle.ts";
import { attachment, skillZipBodyLimit } from "./skill-download.ts";
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
  return c.json({ ...record, files: await skillFilesForApi(skillId) });
});

/** Import a zip as a new org-scoped Skill (admin only) */
orgSkill.post(
  "/import",
  requireAuth,
  requireOrgAccess(["admin"]),
  skillZipBodyLimit,
  async (c) => {
    // Always a new Skill: a name already taken is a 409 via the central
    // onError (ADR-0010).
    const zip = new Uint8Array(await c.req.arrayBuffer());
    const row = await importSkillBundle(
      { kind: "organization", orgId: orgScopeOf(c).orgId },
      zip,
    );
    return c.json(row, 201);
  },
);

/** Replace an org-scoped Skill's whole bundle from a zip (admin only) */
orgSkill.put(
  "/:skillId/bundle",
  requireAuth,
  requireOrgAccess(["admin"]),
  skillZipBodyLimit,
  async (c) => {
    const zip = new Uint8Array(await c.req.arrayBuffer());
    const row = await replaceSkillBundle(
      { kind: "organization", orgId: orgScopeOf(c).orgId },
      c.req.param("skillId"),
      zip,
    );
    return c.json(row, 200);
  },
);

/** Export an org-scoped Skill as a zip */
orgSkill.get("/:skillId/export", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const record = await requireOrgScoped(
    db,
    "skill",
    c.req.param("skillId"),
    orgId,
  );
  const zip = await exportSkillBundle(record);
  return attachment(c, zip, `${record.name}.zip`, "application/zip");
});

/** Download one bundled file of an org-scoped Skill */
orgSkill.get(
  "/:skillId/files/:fileId",
  requireAuth,
  requireOrgAccess(),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const skillId = c.req.param("skillId");
    await requireOrgScoped(db, "skill", skillId, orgId);
    const { data, filename } = await downloadSkillFile(
      skillId,
      c.req.param("fileId"),
    );
    return attachment(c, data, filename, SKILL_FILE_CONTENT_TYPE);
  },
);

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
