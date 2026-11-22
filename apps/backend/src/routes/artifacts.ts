import { Hono } from "hono";
import { z } from "zod";
import {
  artifactCreateSchema,
  artifactListSchema,
  artifactReadSchema,
  artifactSchema,
  artifactTypeSchema,
  artifactUpdateSchema,
  artifactVersionListSchema,
  artifactVersionQuerySchema,
} from "@platypus/schemas";
import { paginationQuerySchema, validate } from "../validate.ts";
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

/**
 * The human-facing Artifact routes: the paged list, one Artifact at a named or
 * latest version, its version history, create from an upload, rename and
 * delete, under the same access rule as Chats. Reads are open to anyone with Workspace access; the writes that
 * change what everyone sees are the Workspace Owner's.
 */
const artifacts = new Hono<{ Variables: Variables }>();

const readers = [
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
] as const;
const owner = [...readers, requireWorkspaceOwner] as const;

const listQuerySchema = paginationQuerySchema(50).extend({
  search: z.string().optional(),
  type: artifactTypeSchema.optional(),
});

/**
 * One Artifact read, with the deployment settings the viewer needs: the library
 * origins the Artifact frame may load from, and the base stored files are served
 * from. Every read carries them, so the viewer builds the frame's policy and
 * recognises the deployment's own images without fetching a setting of its own.
 */
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
  validate("query", listQuerySchema),
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
