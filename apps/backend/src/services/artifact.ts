import { and, count, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  ARTIFACT_CONTENT_TOO_LARGE_MESSAGE,
  ARTIFACT_TITLE_MAX_LENGTH,
  ARTIFACT_TITLE_MIN_LENGTH,
  artifactContentSchema,
  artifactTitleSchema,
  type ArtifactAuthor,
  type ArtifactEdit,
  type ArtifactType,
} from "@platypus/schemas";
import {
  artifact as artifactTable,
  artifactVersion as artifactVersionTable,
} from "../db/schema.ts";
import { oneRow } from "../db/one-row.ts";
import { NotFoundError, ValidationError } from "../errors.ts";
import type { db, Tx } from "../index.ts";

export type ArtifactDatabase = typeof db;
type ArtifactExecutor = ArtifactDatabase | Tx;

export type ArtifactScope = { workspaceId: string };

export const scopedArtifact = (artifactId: string, scope: ArtifactScope) =>
  and(
    eq(artifactTable.id, artifactId),
    eq(artifactTable.workspaceId, scope.workspaceId),
  );

export const ARTIFACT_EDIT_RECOVERY =
  "Add surrounding context to make it unique, or call readArtifact to read the current content.";

export type CreateArtifactInput = {
  title: string;
  type: ArtifactType;
  language?: string;
  content: string;
  sourceChatId?: string | null;
  author: ArtifactAuthor;
};

export type RewriteArtifactInput = Omit<CreateArtifactInput, "sourceChatId">;

export function assertArtifactTitle(title: string): void {
  if (!artifactTitleSchema.safeParse(title).success) {
    throw new ValidationError(
      `Artifact title must be between ${ARTIFACT_TITLE_MIN_LENGTH} and ${ARTIFACT_TITLE_MAX_LENGTH} characters`,
    );
  }
}

export function assertArtifactContent(content: string): void {
  if (!artifactContentSchema.safeParse(content).success) {
    throw new ValidationError(ARTIFACT_CONTENT_TOO_LARGE_MESSAGE);
  }
}

function assertUploadText(content: string): void {
  if (content.includes("\u0000")) {
    throw new ValidationError("Artifact content is not text");
  }
}

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

export type CreateUploadedArtifactInput = {
  title: string;
  type: ArtifactType;
  language?: string;
  content: string;
};

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

function editPreview(old: string): string {
  const shown = old.length > 60 ? `${old.slice(0, 60)}…` : old;
  return JSON.stringify(shown);
}

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

export type ListArtifactsQuery = {
  limit: number;
  offset: number;
  search?: string;
  type?: ArtifactType;
};

export async function listArtifacts(
  database: ArtifactDatabase,
  scope: ArtifactScope,
  query: ListArtifactsQuery,
) {
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

    // why: artifact_version cascades from artifact in db/schema.ts
    await tx.delete(artifactTable).where(scopedArtifact(artifactId, scope));
  });
}
