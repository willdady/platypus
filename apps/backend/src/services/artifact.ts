import { and, count, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  ARTIFACT_CONTENT_MAX_BYTES,
  ARTIFACT_TITLE_MAX_LENGTH,
  ARTIFACT_TITLE_MIN_LENGTH,
  artifactContentByteLength,
  type ArtifactAuthor,
  type ArtifactEdit,
  type ArtifactType,
} from "@platypus/schemas";
import {
  artifact as artifactTable,
  artifactVersion as artifactVersionTable,
} from "../db/schema.ts";
import { oneRow } from "../db/one-row.ts";
import { ConflictError, NotFoundError, ValidationError } from "../errors.ts";
import type { db, Tx } from "../index.ts";

/**
 * The Artifact model shared by the HTTP routes and the Agent Tool set: both
 * surfaces resolve an Artifact by id inside one Workspace. This module owns
 * creation, reads, the paged list, the three human edits — rename, delete and
 * a markdown hand edit saved as a version — and the Agent-driven versions: a
 * whole rewrite and targeted edits. Every write appends, never overwrites, and
 * every write takes the Artifact's row lock inside its transaction.
 */

export type ArtifactDatabase = typeof db;
type ArtifactExecutor = ArtifactDatabase | Tx;

/** Everything an Artifact read is confined to: its Workspace, never across it. */
export type ArtifactScope = { workspaceId: string };

/** An Artifact id inside one Workspace — the one predicate every read and write uses. */
export const scopedArtifact = (artifactId: string, scope: ArtifactScope) =>
  and(
    eq(artifactTable.id, artifactId),
    eq(artifactTable.workspaceId, scope.workspaceId),
  );

/** What an edit failure tells the model to do next; the tool description repeats it. */
export const ARTIFACT_EDIT_RECOVERY =
  "Add surrounding context to make it unique, or call readArtifact to read the current content.";

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

/** The whole content of a rewrite: the `createArtifact({ id })` path. */
export type RewriteArtifactInput = {
  title: string;
  type: ArtifactType;
  language?: string;
  content: string;
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
 * The rule User-supplied content is held to — an upload, or a hand edit. The
 * browser decodes an uploaded file's bytes strictly before posting; this is
 * the same rule from the other side, so a client that skipped it cannot store
 * a document Postgres cannot hold. A NUL character is refused; U+FFFD is
 * ordinary text and is kept. Not applied to an Agent's own content, which
 * never reaches this path.
 */
function assertArtifactText(content: string): void {
  if (content.includes("\u0000")) {
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
 * over the cap or one that is not UTF-8 text before sending it; the cap, and
 * the one text rule a JSON body can still break, are enforced here too, so a
 * client that bypassed the browser cannot store a document Postgres cannot
 * hold.
 */
export async function createUploadedArtifact(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  input: CreateUploadedArtifactInput,
) {
  assertArtifactText(input.content);
  return await createArtifact(database, scope, {
    ...input,
    author: "user",
    sourceChatId: null,
  });
}

/**
 * Resolves an Artifact inside its Workspace — the one lookup every read and
 * write is built on. With `lock`, the row is held `FOR UPDATE` for the rest of
 * the transaction: everything a write does next (reading the latest version,
 * choosing the next number, updating `updatedAt`) happens under that lock, so
 * a second writer waits and then sees the first one's version instead of
 * choosing the same number. An id from another Workspace is indistinguishable
 * from one that never existed.
 */
async function findArtifact(
  runner: ArtifactExecutor,
  scope: ArtifactScope,
  artifactId: string,
  lock = false,
) {
  const scoped = scopedArtifact(artifactId, scope);

  const [artifact] = lock
    ? await runner
        .select()
        .from(artifactTable)
        .where(scoped)
        .for("update")
        .limit(1)
    : await runner.select().from(artifactTable).where(scoped).limit(1);

  if (!artifact) throw new NotFoundError("Artifact not found");
  return artifact;
}

/** The newest version of an Artifact, the one an edit is applied to. */
async function latestVersion(tx: Tx, artifactId: string) {
  const [version] = await tx
    .select()
    .from(artifactVersionTable)
    .where(eq(artifactVersionTable.artifactId, artifactId))
    .orderBy(desc(artifactVersionTable.version))
    .limit(1);

  return version;
}

type ArtifactRow = typeof artifactTable.$inferSelect;
type ArtifactVersionRow = typeof artifactVersionTable.$inferSelect;
type ArtifactPatch = Partial<{ title: string; language: string | null }>;

/**
 * Appends one whole-content version and moves the Artifact's `updatedAt` with
 * it. The caller holds the Artifact's row lock and has already read `latest`,
 * so `latest.version + 1` cannot be claimed by anyone else in the meantime.
 */
async function appendVersion(
  tx: Tx,
  artifact: ArtifactRow,
  latest: ArtifactVersionRow,
  content: string,
  author: ArtifactAuthor,
  patch: ArtifactPatch = {},
) {
  const now = new Date();
  const version = oneRow(
    await tx
      .insert(artifactVersionTable)
      .values({
        id: nanoid(),
        artifactId: artifact.id,
        version: latest.version + 1,
        content,
        author,
        createdAt: now,
      })
      .returning(),
  );

  const updated = oneRow(
    await tx
      .update(artifactTable)
      .set({ ...patch, updatedAt: now })
      .where(eq(artifactTable.id, artifact.id))
      .returning(),
  );

  return { artifact: updated, version };
}

/**
 * Writes the whole content as a new version — `createArtifact({ id })`'s
 * full-rewrite path. The type is fixed when the Artifact is created, so a call
 * that names another one is refused before anything is written. A code
 * Artifact keeps its language unless the rewrite names another.
 */
export async function rewriteArtifact(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  artifactId: string,
  input: RewriteArtifactInput,
) {
  assertArtifactTitle(input.title);
  assertArtifactContent(input.content);

  return await database.transaction(async (tx) => {
    const artifact = await findArtifact(tx, scope, artifactId, true);

    if (artifact.type !== input.type) {
      throw new ValidationError(
        `Artifact type cannot change from ${artifact.type} to ${input.type}`,
      );
    }

    const latest = await latestVersion(tx, artifact.id);
    if (!latest) throw new NotFoundError("Artifact version not found");

    return await appendVersion(
      tx,
      artifact,
      latest,
      input.content,
      input.author,
      {
        title: input.title,
        language:
          input.type === "code" ? (input.language ?? artifact.language) : null,
      },
    );
  });
}

/**
 * What a save based on a stale version tells the reader: the Artifact moved on
 * under the edit, and the text they typed is still theirs to copy.
 */
export const ARTIFACT_CHANGED_CONFLICT =
  "This Artifact changed while you were editing it. Reload to see the latest version.";

/**
 * Saves a hand edit as a new `user` version. The text is written against the
 * version it was edited from — named by the caller — so the check and the
 * insert both happen under the Artifact's row lock: an Agent's change that
 * lands between them makes the save a conflict instead of overwriting it.
 * Only markdown can be hand-edited; every other type is refused.
 */
export async function saveArtifactContent(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  artifactId: string,
  input: { content: string; baseVersion: number },
) {
  assertArtifactContent(input.content);
  assertArtifactText(input.content);

  return await database.transaction(async (tx) => {
    const artifact = await findArtifact(tx, scope, artifactId, true);

    if (artifact.type !== "markdown") {
      throw new ValidationError("Only markdown Artifacts can be hand-edited");
    }

    const latest = await latestVersion(tx, artifact.id);
    if (!latest) throw new NotFoundError("Artifact version not found");

    if (latest.version !== input.baseVersion) {
      throw new ConflictError(ARTIFACT_CHANGED_CONFLICT);
    }

    return await appendVersion(tx, artifact, latest, input.content, "user");
  });
}

/** The quoted, shortened needle an edit failure names. */
function editPreview(old: string): string {
  const shown = old.length > 60 ? `${old.slice(0, 60)}…` : old;
  return JSON.stringify(shown);
}

/** The first occurrence of `needle` and how many times it occurs, overlaps included. */
function findMatches(
  content: string,
  needle: string,
): { first: number; count: number } {
  let first = -1;
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    if (first === -1) first = index;
    count += 1;
    index = content.indexOf(needle, index + 1);
  }
  return { first, count };
}

/**
 * Applies targeted edits to the latest version, in order, and writes exactly
 * one new version. Each `old` is matched against the text as it stands when
 * that edit runs — so a chain can build on the previous replacement — and must
 * occur exactly once there. Every edit is checked before anything is written:
 * a needle that matches zero times or more than once fails the call, names the
 * edit and tells the model how to recover, and leaves the Artifact untouched.
 */
export async function editArtifact(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  artifactId: string,
  edits: ArtifactEdit[],
  author: ArtifactAuthor,
) {
  if (edits.length === 0) {
    throw new ValidationError("At least one edit is required");
  }

  return await database.transaction(async (tx) => {
    const artifact = await findArtifact(tx, scope, artifactId, true);
    const latest = await latestVersion(tx, artifact.id);
    if (!latest) throw new NotFoundError("Artifact version not found");

    let content = latest.content;
    edits.forEach((edit, index) => {
      if (edit.old.length === 0) {
        throw new ValidationError(
          `Edit ${index + 1} must have a non-empty \`old\` string. ${ARTIFACT_EDIT_RECOVERY}`,
        );
      }

      const { first, count } = findMatches(content, edit.old);
      if (count !== 1) {
        throw new ValidationError(
          `Edit ${index + 1} (${editPreview(edit.old)}) must match exactly once, but matched ${count} ${count === 1 ? "time" : "times"}. ${ARTIFACT_EDIT_RECOVERY}`,
        );
      }

      content =
        content.slice(0, first) +
        edit.new +
        content.slice(first + edit.old.length);
    });

    assertArtifactContent(content);

    return await appendVersion(tx, artifact, latest, content, author);
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
  const artifact = await findArtifact(database, scope, artifactId);

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

/**
 * Every version of one Artifact, newest first, without its content. Confined
 * to the Workspace: another Workspace's Artifact is not found rather than
 * listed empty. The viewer's version picker reads this, so a version number is
 * always shown with who wrote it and when.
 */
export async function listArtifactVersions(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  artifactId: string,
) {
  await findArtifact(database, scope, artifactId);

  return await database
    .select({
      id: artifactVersionTable.id,
      artifactId: artifactVersionTable.artifactId,
      version: artifactVersionTable.version,
      author: artifactVersionTable.author,
      createdAt: artifactVersionTable.createdAt,
    })
    .from(artifactVersionTable)
    .where(eq(artifactVersionTable.artifactId, artifactId))
    .orderBy(desc(artifactVersionTable.version));
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
 * the reader is actually looking at. The Agent's `listArtifacts` tool reads the
 * first page through this same query, so the two can never disagree.
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
