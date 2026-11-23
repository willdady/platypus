import { Hono } from "hono";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import {
  skillCreateSchema,
  skillGithubInstallRequestSchema,
  skillGithubPreviewRequestSchema,
  skillGithubUpdateRequestSchema,
  skillUpdateSchema,
} from "@platypus/schemas";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import {
  listOrgScoped,
  requireOrgScoped,
} from "../services/scoped-resource.ts";
import { createSkill, deleteSkill, updateSkill } from "../services/skill.ts";
import { skillResponse } from "../services/scoped-response.ts";
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
import {
  getSkillImportAccess,
  setSkillImportAccess,
} from "../services/skill-import-gate.ts";
import { attachment, skillZipBodyLimit } from "./skill-download.ts";
import { mountGateAccess } from "./org-gate-access.ts";
import type { Variables } from "../server.ts";

const orgSkill = new Hono<{ Variables: Variables }>();

orgSkill.post(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", skillCreateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const data = c.req.valid("json");

    const row = await createSkill({ kind: "organization", orgId }, data);
    return c.json(skillResponse(row, "organization"), 201);
  },
);

orgSkill.get("/", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const results = await listOrgScoped(db, "skill", orgId);
  return c.json({
    results: results.map((row) => skillResponse(row, "organization")),
  });
});

orgSkill.get("/:skillId", requireAuth, requireOrgAccess(), async (c) => {
  const { orgId } = orgScopeOf(c);
  const skillId = c.req.param("skillId");
  const record = await requireOrgScoped(db, "skill", skillId, orgId);
  return c.json({
    ...skillResponse(record, "organization"),
    files: await skillFilesForApi(skillId),
    modified: isModified(record),
  });
});

orgSkill.post(
  "/import",
  requireAuth,
  requireOrgAccess(["admin"]),
  skillZipBodyLimit,
  async (c) => {
    const zip = new Uint8Array(await c.req.arrayBuffer());
    const row = await importSkillBundle(
      { kind: "organization", orgId: orgScopeOf(c).orgId },
      zip,
    );
    return c.json(skillResponse(row, "organization"), 201);
  },
);

orgSkill.post(
  "/github/preview",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", skillGithubPreviewRequestSchema),
  async (c) =>
    c.json(
      await previewGithubSkills(
        { kind: "organization", orgId: orgScopeOf(c).orgId },
        c.req.valid("json").source,
      ),
    ),
);

orgSkill.post(
  "/github/install",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", skillGithubInstallRequestSchema),
  async (c) =>
    c.json(
      await installGithubSkills(
        { kind: "organization", orgId: orgScopeOf(c).orgId },
        c.req.valid("json"),
      ),
    ),
);

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
    return c.json(skillResponse(row, "organization"), 200);
  },
);

orgSkill.post(
  "/:skillId/github/check",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) =>
    c.json(
      await checkGithubSkillUpdate(
        { kind: "organization", orgId: orgScopeOf(c).orgId },
        c.req.param("skillId"),
      ),
    ),
);

orgSkill.post(
  "/:skillId/github/update",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", skillGithubUpdateRequestSchema),
  async (c) =>
    c.json(
      await updateGithubSkill(
        { kind: "organization", orgId: orgScopeOf(c).orgId },
        c.req.param("skillId"),
        c.req.valid("json").commitSha,
      ),
    ),
);

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

orgSkill.put(
  "/:skillId",
  requireAuth,
  requireOrgAccess(["admin"]),
  validate("json", skillUpdateSchema),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const skillId = c.req.param("skillId");
    const data = c.req.valid("json");

    const row = await updateSkill(
      { kind: "organization", orgId },
      skillId,
      data,
    );
    return c.json(skillResponse(row, "organization"), 200);
  },
);

orgSkill.delete(
  "/:skillId",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    const skillId = c.req.param("skillId");

    await deleteSkill({ kind: "organization", orgId }, skillId);

    return c.json({ message: "Skill deleted" });
  },
);

const orgSkillImport = new Hono<{ Variables: Variables }>();
mountGateAccess(orgSkillImport, getSkillImportAccess, setSkillImportAccess);

export { orgSkill, orgSkillImport };
