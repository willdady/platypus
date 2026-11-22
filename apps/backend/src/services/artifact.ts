import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  ARTIFACT_CONTENT_MAX_BYTES,
  ARTIFACT_TITLE_MAX_LENGTH,
  ARTIFACT_TITLE_MIN_LENGTH,
  artifactContentByteLength,
  type ArtifactAuthor,
  type ArtifactType,
} from "@platypus/schemas";
import {
  artifact as artifactTable,
  artifactVersion as artifactVersionTable,
} from "../db/schema.ts";
import { oneRow } from "../db/one-row.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { db } from "../index.ts";

/**
 * The Artifact model shared by the HTTP read route and the Agent Tool set:
 * both surfaces resolve an Artifact by id inside one Workspace, and the Tool
 * set writes version 1. Editing, renaming, paging and the other tools arrive
 * with later slices of the feature; this module holds only what the creation
 * path needs, so the rules live in one place from the start.
 */

export type ArtifactDatabase = typeof db;

/** Everything an Artifact read is confined to: its Workspace, never across it. */
export type ArtifactScope = { workspaceId: string };

export type CreateArtifactInput = {
  title: string;
  type: ArtifactType;
  /** Set for `code` Artifacts; stored as null for every other type. */
  language?: string;
  content: string;
  /** The Chat, or Trigger run Chat, whose turn created it. */
  sourceChatId?: string | null;
  author: ArtifactAuthor;
};

/** A title within its bound, refused whole rather than truncated. */
export function assertArtifactTitle(title: string): void {
  if (
    title.length < ARTIFACT_TITLE_MIN_LENGTH ||
    title.length > ARTIFACT_TITLE_MAX_LENGTH
  ) {
    throw new ValidationError(
      `Artifact title must be between ${ARTIFACT_TITLE_MIN_LENGTH} and ${ARTIFACT_TITLE_MAX_LENGTH} characters`,
    );
  }
}

/** Content within its per-version byte cap, refused whole rather than truncated. */
export function assertArtifactContent(content: string): void {
  if (artifactContentByteLength(content) > ARTIFACT_CONTENT_MAX_BYTES) {
    throw new ValidationError(
      `Artifact content must be at most ${ARTIFACT_CONTENT_MAX_BYTES / 1024} KB`,
    );
  }
}

/**
 * Creates an Artifact and its version 1. Both rows land before the caller sees
 * anything, so a Card that receives the result can read it back at once.
 */
export async function createArtifact(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  input: CreateArtifactInput,
) {
  assertArtifactTitle(input.title);
  assertArtifactContent(input.content);

  const now = new Date();
  return await database.transaction(async (tx) => {
    const artifact = oneRow(
      await tx
        .insert(artifactTable)
        .values({
          id: nanoid(),
          workspaceId: scope.workspaceId,
          sourceChatId: input.sourceChatId ?? null,
          title: input.title,
          type: input.type,
          language: input.type === "code" ? (input.language ?? null) : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
    );

    const version = oneRow(
      await tx
        .insert(artifactVersionTable)
        .values({
          id: nanoid(),
          artifactId: artifact.id,
          version: 1,
          content: input.content,
          author: input.author,
          createdAt: now,
        })
        .returning(),
    );

    return { artifact, version };
  });
}

/**
 * Reads one Artifact and one of its versions — the named one, or the latest
 * when none is named. A missing Artifact and a missing version are both
 * not-found, and an id from another Workspace is indistinguishable from one
 * that never existed.
 */
export async function getArtifactWithVersion(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  artifactId: string,
  version?: number,
) {
  const [artifact] = await database
    .select()
    .from(artifactTable)
    .where(
      and(
        eq(artifactTable.id, artifactId),
        eq(artifactTable.workspaceId, scope.workspaceId),
      ),
    )
    .limit(1);

  if (!artifact) throw new NotFoundError("Artifact not found");

  const [versionRow] = await database
    .select()
    .from(artifactVersionTable)
    .where(
      and(
        eq(artifactVersionTable.artifactId, artifactId),
        ...(version === undefined
          ? []
          : [eq(artifactVersionTable.version, version)]),
      ),
    )
    .orderBy(desc(artifactVersionTable.version))
    .limit(1);

  if (!versionRow) throw new NotFoundError("Artifact version not found");

  return { artifact, version: versionRow };
}
