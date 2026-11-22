import { and, count, desc, eq, sql } from "drizzle-orm";
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
 * The Artifact model shared by the HTTP routes and the Agent Tool set: both
 * surfaces resolve an Artifact by id inside one Workspace. This module owns
 * creation, reads, the paged list and the two human edits — rename and delete
 * — so the rules live in one place. Agent-driven versions and hand saves are
 * later slices and will extend this module rather than add a parallel one.
 */

export type ArtifactDatabase = typeof db;

/** Everything an Artifact read is confined to: its Workspace, never across it. */
export type ArtifactScope = { workspaceId: string };

/** An Artifact id inside one Workspace — the one predicate every read and write uses. */
const scopedArtifact = (artifactId: string, scope: ArtifactScope) =>
  and(
    eq(artifactTable.id, artifactId),
    eq(artifactTable.workspaceId, scope.workspaceId),
  );

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
 * The rule an uploaded file's content is held to. The browser decodes the
 * file's bytes strictly before posting; this is the same rule from the other
 * side, so a client that skipped it — or decoded lossily and sent replacement
 * characters — cannot store a mangled document. It is not applied to an
 * Agent's own content: a model may legitimately quote a rejection character.
 */
function assertUploadText(content: string): void {
  if (content.includes("\u0000") || content.includes("\uFFFD")) {
    throw new ValidationError("Artifact content is not text");
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

/** What an uploaded file becomes: the fields the create body carries. */
export type CreateUploadedArtifactInput = {
  title: string;
  type: ArtifactType;
  language?: string;
  content: string;
};

/**
 * Creates an Artifact and its version 1 from a file the User uploaded: the
 * version is the User's and there is no source Chat. The browser refuses a file
 * over the cap or one outside UTF-8 text before sending it; this is the same
 * two refusals enforced here, so a client that bypassed the browser cannot
 * store a truncated or mangled document either.
 */
export async function createUploadedArtifact(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  input: CreateUploadedArtifactInput,
) {
  assertUploadText(input.content);
  return await createArtifact(database, scope, {
    ...input,
    author: "user",
    sourceChatId: null,
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
    .where(scopedArtifact(artifactId, scope))
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

/** One page of a Workspace's Artifacts, plus the total the page was cut from. */
export type ListArtifactsQuery = {
  limit: number;
  offset: number;
  /** Title search, case-insensitive. Omitted or blank means every title. */
  search?: string;
  type?: ArtifactType;
};

/**
 * Lists a Workspace's Artifacts, newest change first, so the page is quick to
 * scan and a paged list stays put as Artifacts change. The search and type
 * filter are applied by the database, not the caller, so paging counts what
 * the reader is actually looking at.
 */
export async function listArtifacts(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  query: ListArtifactsQuery,
) {
  // `\` is Postgres's default LIKE escape, so escaping `%`, `_` and `\` matches
  // them literally rather than turning the reader's text into a wildcard.
  const term = query.search?.trim().replace(/[\\%_]/g, "\\$&");
  const where = and(
    eq(artifactTable.workspaceId, scope.workspaceId),
    term ? sql`${artifactTable.title} ILIKE ${`%${term}%`}` : undefined,
    query.type ? eq(artifactTable.type, query.type) : undefined,
  );

  const results = await database
    .select()
    .from(artifactTable)
    .where(where)
    .orderBy(desc(artifactTable.updatedAt), desc(artifactTable.id))
    .limit(query.limit)
    .offset(query.offset);

  const { totalCount } = oneRow(
    await database
      .select({ totalCount: count() })
      .from(artifactTable)
      .where(where),
  );

  return { results, totalCount };
}

/**
 * Renames an Artifact. The title is held to the same bound as creation and
 * refused whole; the change also moves the Artifact to the top of the
 * most-recently-updated list.
 */
export async function renameArtifact(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  artifactId: string,
  title: string,
) {
  assertArtifactTitle(title);

  const [artifact] = await database
    .update(artifactTable)
    .set({ title, updatedAt: new Date() })
    .where(scopedArtifact(artifactId, scope))
    .returning();

  if (!artifact) throw new NotFoundError("Artifact not found");
  return artifact;
}

/**
 * Deletes an Artifact and its versions as one unit. Versions are removed
 * explicitly rather than leaning on the foreign key alone, so the rule holds
 * for any database stand-in as well as Postgres. An id from another Workspace
 * is a 404 and changes nothing.
 */
export async function deleteArtifact(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  artifactId: string,
) {
  await database.transaction(async (tx) => {
    const [artifact] = await tx
      .select({ id: artifactTable.id })
      .from(artifactTable)
      .where(scopedArtifact(artifactId, scope))
      .limit(1);

    if (!artifact) throw new NotFoundError("Artifact not found");

    await tx
      .delete(artifactVersionTable)
      .where(eq(artifactVersionTable.artifactId, artifactId));
    await tx.delete(artifactTable).where(scopedArtifact(artifactId, scope));
  });
}
