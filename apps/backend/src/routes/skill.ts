import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import { agent as agentTable } from "../db/schema.ts";
import {
  skillCreateSchema,
  skillGithubInstallRequestSchema,
  skillGithubPreviewRequestSchema,
  skillGithubUpdateRequestSchema,
  skillUpdateSchema,
} from "@platypus/schemas";
import { eq, and, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { listScoped, requireScoped } from "../services/scoped-resource.ts";
import { skillResponse } from "../services/scoped-response.ts";
import { createSkill, deleteSkill, updateSkill } from "../services/skill.ts";
import {
  exportSkillBundle,
  importSkillBundle,
  downloadSkillFile,
  isModified,
  replaceSkillBundle,
  SKILL_FILE_CONTENT_TYPE,
  skillFilesForApi,
} from "../services/skill-bundle.ts";
import {
  checkGithubSkillUpdate,
  installGithubSkills,
  previewGithubSkills,
  updateGithubSkill,
} from "../services/skill-github.ts";
import { skillImportAllowed } from "../services/skill-import-gate.ts";
import { promoteScoped } from "../services/promote.ts";
import { attachment, skillZipBodyLimit } from "./skill-download.ts";
import type { Variables } from "../server.ts";

const skill = new Hono<{ Variables: Variables }>();

const requireSkillImport = createMiddleware<{ Variables: Variables }>(
  async (c, next) => {
    if (!(await skillImportAllowed(workspaceScopeOf(c).workspaceId))) {
      return c.json(
        {
          error:
            "Your Organization doesn't allow importing Skills into this Workspace",
        },
        403,
      );
    }
    await next();
    return;
  },
);

skill.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scoped = await listScoped(db, "skill", workspaceScopeOf(c));
    const results = scoped.map(({ row, scope }) => skillResponse(row, scope));

    return c.json({ results });
  },
);

skill.get(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");

    const found = await requireScoped(db, "skill", skillId, scope);

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
      ...skillResponse(found.row, found.scope),
      agentIds: agentsWithSkill.map((a) => a.id),
      files: await skillFilesForApi(skillId),
      modified: isModified(found.row),
    });
  },
);

skill.post(
  "/import",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSkillImport,
  skillZipBodyLimit,
  async (c) => {
    const zip = new Uint8Array(await c.req.arrayBuffer());
    const row = await importSkillBundle(
      { kind: "workspace", ctx: workspaceScopeOf(c) },
      zip,
    );
    return c.json(skillResponse(row, "workspace"), 201);
  },
);

skill.put(
  "/:skillId/bundle",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSkillImport,
  skillZipBodyLimit,
  async (c) => {
    const zip = new Uint8Array(await c.req.arrayBuffer());
    const row = await replaceSkillBundle(
      { kind: "workspace", ctx: workspaceScopeOf(c) },
      c.req.param("skillId"),
      zip,
    );
    return c.json(skillResponse(row, "workspace"), 200);
  },
);

skill.post(
  "/github/preview",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSkillImport,
  validate("json", skillGithubPreviewRequestSchema),
  async (c) =>
    c.json(
      await previewGithubSkills(
        { kind: "workspace", ctx: workspaceScopeOf(c) },
        c.req.valid("json").source,
      ),
    ),
);

skill.post(
  "/github/install",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSkillImport,
  validate("json", skillGithubInstallRequestSchema),
  async (c) =>
    c.json(
      await installGithubSkills(
        { kind: "workspace", ctx: workspaceScopeOf(c) },
        c.req.valid("json"),
      ),
    ),
);

skill.post(
  "/:skillId/github/check",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSkillImport,
  async (c) =>
    c.json(
      await checkGithubSkillUpdate(
        { kind: "workspace", ctx: workspaceScopeOf(c) },
        c.req.param("skillId"),
      ),
    ),
);

skill.post(
  "/:skillId/github/update",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireSkillImport,
  validate("json", skillGithubUpdateRequestSchema),
  async (c) =>
    c.json(
      await updateGithubSkill(
        { kind: "workspace", ctx: workspaceScopeOf(c) },
        c.req.param("skillId"),
        c.req.valid("json").commitSha,
      ),
    ),
);

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

skill.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", skillCreateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const data = c.req.valid("json");

    const row = await createSkill({ kind: "workspace", ctx: scope }, data);
    return c.json(skillResponse(row, "workspace"), 201);
  },
);

skill.put(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("json", skillUpdateSchema),
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");
    const data = c.req.valid("json");

    const row = await updateSkill(
      { kind: "workspace", ctx: scope },
      skillId,
      data,
    );
    return c.json(skillResponse(row, "workspace"), 200);
  },
);

skill.delete(
  "/:skillId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const scope = workspaceScopeOf(c);
    const skillId = c.req.param("skillId");

    await deleteSkill({ kind: "workspace", ctx: scope }, skillId);

    return c.json({ message: "Skill deleted" });
  },
);

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

    return c.json(skillResponse(outcome.row, "organization"), 200);
  },
);

export { skill };
