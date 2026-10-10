import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import { skillCreateSchema, skillUpdateSchema } from "@platypus/schemas";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { listScoped, requireScoped } from "../services/scoped-resource.ts";
import { createSkill, deleteSkill, updateSkill } from "../services/skill.ts";
import {
  exportSkillBundle,
  importSkillBundle,
  downloadSkillFile,
  replaceSkillBundle,
  SKILL_FILE_CONTENT_TYPE,
  skillFilesForApi,
} from "../services/skill-bundle.ts";
import { promoteScoped } from "../services/promote.ts";
import { attachment, skillZipBodyLimit } from "./skill-download.ts";
import type { Variables } from "../server.ts";

const skill = new Hono<{ Variables: Variables }>();

/** List skills visible in this workspace (workspace-scoped + attached org-scoped) */
skill.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    // Workspace-scoped Skills plus the attached org-scoped (Shared) ones, each
    // tagged with its scope for the frontend (locked cards for org).
    const scoped = await listScoped(db, "skill", workspaceScopeOf(c));
    const results = scoped.map(({ row, scope }) => ({ ...row, scope }));

    return c.json({ results });
  },
);

/** Get a skill by ID */
skill.get(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");

    // Resolve the Skill visible here — Workspace-scoped, or an attached
    // org-scoped (Shared) one (ADR-0007); not visible → 404 via onError.
    const found = await requireScoped(db, "skill", skillId, scope);

    // Find workspace agents that have this skill assigned
    const agentsWithSkill = await db
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(
        and(
          eq(agentTable.workspaceId, scope.workspaceId),
          sql`${agentTable.skillIds} @> ${JSON.stringify([skillId])}::jsonb`,
        ),
      );

    return c.json({
      ...found.row,
      scope: found.scope,
      agentIds: agentsWithSkill.map((a) => a.id),
      files: await skillFilesForApi(skillId),
    });
  },
);

/** Import a zip as a new workspace-scoped Skill (editor+) */
skill.post(
  "/import",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  skillZipBodyLimit,
  async (c) => {
    // Always a new Skill: a name already taken here is a 409 via the central
    // onError (ADR-0010); Replace bundle is the re-import path.
    const zip = new Uint8Array(await c.req.arrayBuffer());
    const row = await importSkillBundle(
      { kind: "workspace", ctx: workspaceScopeOf(c) },
      zip,
    );
    return c.json(row, 201);
  },
);

/** Replace a workspace-scoped Skill's whole bundle from a zip (editor+) */
skill.put(
  "/:skillId/bundle",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  skillZipBodyLimit,
  async (c) => {
    // A Shared Skill is locked here like any edit (ADR-0007).
    const zip = new Uint8Array(await c.req.arrayBuffer());
    const row = await replaceSkillBundle(
      { kind: "workspace", ctx: workspaceScopeOf(c) },
      c.req.param("skillId"),
      zip,
    );
    return c.json(row, 200);
  },
);

/** Export a visible Skill as a zip */
skill.get(
  "/:skillId/export",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const found = await requireScoped(
      db,
      "skill",
      c.req.param("skillId"),
      workspaceScopeOf(c),
    );
    const zip = await exportSkillBundle(found.row);
    return attachment(c, zip, `${found.row.name}.zip`, "application/zip");
  },
);

/** Download one bundled file of a visible Skill */
skill.get(
  "/:skillId/files/:fileId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const skillId = c.req.param("skillId");
    await requireScoped(db, "skill", skillId, workspaceScopeOf(c));
    const { data, filename } = await downloadSkillFile(
      skillId,
      c.req.param("fileId"),
    );
    return attachment(c, data, filename, SKILL_FILE_CONTENT_TYPE);
  },
);

/** Create a new skill (editor+) */
skill.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", skillCreateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const data = c.req.valid("json");

    // The workspace route only ever creates workspace-scoped Skills; the scope
    // is taken from the route, never the body (org-scoped Skills are created
    // via the Organization surface or by Promote). A duplicate name surfaces as
    // a Postgres unique violation, mapped to 409 by the central onError
    // (ADR-0010).
    const row = await createSkill({ kind: "workspace", ctx: scope }, data);
    return c.json(row, 201);
  },
);

/** Update a skill by ID (editor+) */
skill.put(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", skillUpdateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");
    const data = c.req.valid("json");

    // A Shared Skill is a single source of truth edited only on the Organization
    // surface (ADR-0007); `updateSkill` throws NotFound (→404) when the Skill is
    // not visible here, then Locked (→403) when it is org-scoped. A duplicate
    // name surfaces as a Postgres unique violation, mapped to 409 by the
    // central onError (ADR-0010).
    const row = await updateSkill(
      { kind: "workspace", ctx: scope },
      skillId,
      data,
    );
    return c.json(row, 200);
  },
);

/** Delete a skill by ID (editor+) */
skill.delete(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");

    // A Shared Skill is deleted only from the Organization surface (ADR-0007):
    // `deleteSkill` throws NotFound (→404) when the Skill is not visible here,
    // then Locked (→403) when it is org-scoped, and Conflict (→409) while a
    // Workspace agent still references it.
    await deleteSkill({ kind: "workspace", ctx: scope }, skillId);

    return c.json({ message: "Skill deleted" });
  },
);

/**
 * Promote a workspace-scoped Skill to Organization scope (admin only — ADR-0007).
 *
 * Re-scopes the Skill from this Workspace to the Organization, turning it into a
 * Shared resource, and auto-attaches the origin Workspace so the author keeps
 * using/editing it in place. A Skill is leaf text (it references no other
 * resource), so it passes no no-cascade guard — Skills establish the Promote
 * pattern that Agents build on. Workspace Agents that already reference the
 * Skill keep their references intact (the id is unchanged) and resolve it at
 * Chat-turn time via the Attachment.
 */
skill.post(
  "/:skillId/promote",
  requireAuth,
  requireOrgAccess(["admin"]),
  requireWorkspaceAccess,
  async (c) => {
    const { orgId, workspaceId } = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");

    const outcome = await promoteScoped(db, {
      type: "skill",
      id: skillId,
      orgId,
      workspaceId,
    });

    return c.json({ ...outcome.row, scope: "organization" }, 200);
  },
);

export { skill };
