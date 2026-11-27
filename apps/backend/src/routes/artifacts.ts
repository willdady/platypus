import { Hono } from "hono";
import {
  artifactCreateSchema,
  artifactListQuerySchema,
  artifactListSchema,
  artifactReadSchema,
  artifactSchema,
  artifactUpdateSchema,
  artifactVersionListSchema,
  artifactVersionQuerySchema,
} from "@platypus/schemas";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import { respond } from "../respond.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { env } from "../env.ts";
import { storagePublicBaseUrl } from "../storage/file-reference.ts";
import {
  createUploadedArtifact,
  deleteArtifact,
  getArtifactWithVersion,
  listArtifacts,
  listArtifactVersions,
  renameArtifact,
} from "../services/artifact.ts";
import type { Variables } from "../server.ts";

const artifacts = new Hono<{ Variables: Variables }>();

const readers = [
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
] as const;
const owner = [...readers, requireWorkspaceOwner] as const;

function withViewerSettings(
  read: Awaited<ReturnType<typeof getArtifactWithVersion>>,
) {
  return {
    ...read,
    scriptOrigins: env().ARTIFACT_SCRIPT_ORIGINS,
    storageBaseUrl: storagePublicBaseUrl(),
  };
}

artifacts.get(
  "/",
  ...readers,
  validate("query", artifactListQuerySchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { limit, offset, search, type } = c.req.valid("query");

    return respond(
      c,
      artifactListSchema,
      await listArtifacts(db, { workspaceId }, { limit, offset, search, type }),
    );
  },
);

artifacts.post(
  "/",
  ...owner,
  validate("json", artifactCreateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);

    const { artifact } = await createUploadedArtifact(
      db,
      { workspaceId },
      c.req.valid("json"),
    );

    return respond(c, artifactSchema, artifact, 201);
  },
);

artifacts.get("/:artifactId/versions", ...readers, async (c) => {
  const { workspaceId } = workspaceScopeOf(c);

  return respond(c, artifactVersionListSchema, {
    results: await listArtifactVersions(
      db,
      { workspaceId },
      c.req.param("artifactId"),
    ),
  });
});

artifacts.get(
  "/:artifactId",
  ...readers,
  validate("query", artifactVersionQuerySchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { version } = c.req.valid("query");

    return respond(
      c,
      artifactReadSchema,
      withViewerSettings(
        await getArtifactWithVersion(
          db,
          { workspaceId },
          c.req.param("artifactId"),
          version,
        ),
      ),
    );
  },
);

artifacts.patch(
  "/:artifactId",
  ...owner,
  validate("json", artifactUpdateSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { title } = c.req.valid("json");

    return respond(
      c,
      artifactSchema,
      await renameArtifact(
        db,
        { workspaceId },
        c.req.param("artifactId"),
        title,
      ),
    );
  },
);

artifacts.delete("/:artifactId", ...owner, async (c) => {
  const { workspaceId } = workspaceScopeOf(c);

  await deleteArtifact(db, { workspaceId }, c.req.param("artifactId"));

  return c.json({ message: "Artifact deleted" });
});

export { artifacts };
