import { Hono } from "hono";
import { z } from "zod";
import {
  artifactListSchema,
  artifactReadSchema,
  artifactSaveSchema,
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
import {
  deleteArtifact,
  getArtifactWithVersion,
  listArtifacts,
  listArtifactVersions,
  renameArtifact,
  saveArtifactContent,
} from "../services/artifact.ts";
import type { Variables } from "../server.ts";

/**
 * The human-facing Artifact routes: the paged list, one Artifact at a named or
 * latest version, its version history, a hand edit saved as a new version,
 * rename and delete, under the same access rule as Chats. Creating from an
 * upload arrives with a later slice. Reads are open to anyone with Workspace
 * access; the writes that change what everyone sees are the Workspace Owner's.
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
 * One Artifact read, with the library origins the Artifact frame may load from.
 * Every read carries them, so the viewer builds the frame's policy without
 * fetching a setting of its own.
 */
function withScriptOrigins(
  read: Awaited<ReturnType<typeof getArtifactWithVersion>>,
) {
  return { ...read, scriptOrigins: env().ARTIFACT_SCRIPT_ORIGINS };
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

artifacts.post(
  "/:artifactId/versions",
  ...owner,
  validate("json", artifactSaveSchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { content, baseVersion } = c.req.valid("json");

    return respond(
      c,
      artifactReadSchema,
      withScriptOrigins(
        await saveArtifactContent(
          db,
          { workspaceId },
          c.req.param("artifactId"),
          { content, baseVersion },
        ),
      ),
    );
  },
);

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
      withScriptOrigins(
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
