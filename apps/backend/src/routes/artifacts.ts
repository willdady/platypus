import { Hono } from "hono";
import {
  artifactReadSchema,
  artifactVersionQuerySchema,
} from "@platypus/schemas";
import { validate } from "../validate.ts";
import { db } from "../index.ts";
import { respond } from "../respond.ts";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  workspaceScopeOf,
} from "../middleware/authorization.ts";
import { getArtifactWithVersion } from "../services/artifact.ts";
import { env } from "../env.ts";
import type { Variables } from "../server.ts";

/**
 * The human-facing Artifact read. This slice exposes exactly one route — read
 * one Artifact at a named or latest version — under the same access rule as
 * Chats. Creating from an upload, hand edits, rename, delete and the paged
 * list arrive with later slices.
 */
const artifacts = new Hono<{ Variables: Variables }>();

artifacts.get(
  "/:artifactId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  validate("query", artifactVersionQuerySchema),
  async (c) => {
    const { workspaceId } = workspaceScopeOf(c);
    const { version } = c.req.valid("query");

    return respond(c, artifactReadSchema, {
      ...(await getArtifactWithVersion(
        db,
        { workspaceId },
        c.req.param("artifactId"),
        version,
      )),
      // The viewer builds the Artifact frame's policy from the Operator's list.
      scriptOrigins: env().ARTIFACT_SCRIPT_ORIGINS,
    });
  },
);

export { artifacts };
