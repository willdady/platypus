import { and, asc, eq, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, type Tx } from "../index.ts";
import {
  skill as skillTable,
  skillFile as skillFileTable,
} from "../db/schema.ts";
import { NotFoundError } from "../errors.ts";
import { getStorage } from "../storage/index.ts";
import { skillStorageKeyPrefix } from "../storage/keys.ts";
import { deleteStoredPrefix } from "../storage/utils.ts";
import {
  bundleHash,
  bundleNeedsSandbox,
  buildSkillZip,
  parseSkillZip,
  type ParsedSkillBundle,
  type SkillBundleFields,
  type SkillBundleFile,
} from "./skill-bundle-format.ts";
import {
  orgScopedWhere,
  requireOrgScoped,
  requireWorkspaceMutable,
  workspaceScopedWhere,
  type Database,
} from "./scoped-resource.ts";
import type { SkillRow, SkillScope } from "./skill.ts";
import { oneRow } from "../db/one-row.ts";

export type SkillFileRow = typeof skillFileTable.$inferSelect;

type Executor = Database | Tx;

export const SKILL_FILE_CONTENT_TYPE = "application/octet-stream";

const orgIdOf = (scope: SkillScope) =>
  scope.kind === "workspace" ? scope.ctx.orgId : scope.orgId;

export const scopeColumnsOf = (scope: SkillScope) =>
  scope.kind === "workspace"
    ? { workspaceId: scope.ctx.workspaceId, organizationId: null }
    : { organizationId: scope.orgId, workspaceId: null };

export const writableSkillWhere = async (
  scope: SkillScope,
  skillId: string,
): Promise<SQL> => {
  if (scope.kind === "workspace") {
    await requireWorkspaceMutable(db, "skill", skillId, scope.ctx);
    return workspaceScopedWhere("skill", skillId, scope.ctx.workspaceId);
  }
  await requireOrgScoped(db, "skill", skillId, scope.orgId);
  return orgScopedWhere("skill", skillId, scope.orgId);
};

export const fieldsOf = (row: {
  name: string;
  description: string;
  body: string;
  disableModelInvocation?: boolean;
  argumentHint?: string | null;
}): SkillBundleFields => ({
  name: row.name,
  description: row.description,
  body: row.body,
  disableModelInvocation: row.disableModelInvocation ?? false,
  argumentHint: row.argumentHint ?? null,
});

export const listSkillFiles = (
  database: Executor,
  skillId: string,
): Promise<SkillFileRow[]> =>
  database
    .select()
    .from(skillFileTable)
    .where(eq(skillFileTable.skillId, skillId))
    .orderBy(asc(skillFileTable.path));

export const isModified = (row: SkillRow): boolean =>
  row.installedHash !== null && row.bundleHash !== row.installedHash;

export const hashSkillRow = async (
  database: Executor,
  row: SkillRow,
): Promise<string> =>
  bundleHash({
    fields: fieldsOf(row),
    frontmatter: row.frontmatter,
    files: await listSkillFiles(database, row.id),
  });

export const rehashSkill = async (
  database: Executor,
  row: SkillRow,
): Promise<SkillRow> => {
  const [updated] = await database
    .update(skillTable)
    .set({ bundleHash: await hashSkillRow(database, row) })
    .where(eq(skillTable.id, row.id))
    .returning();
  if (!updated) throw new NotFoundError("Skill not found");
  return updated;
};

const storeFiles = async (
  orgId: string,
  skillId: string,
  files: SkillBundleFile[],
): Promise<{ prefix: string; rows: SkillFileRow[] }> => {
  const prefix = `${skillStorageKeyPrefix({ orgId, skillId })}${nanoid()}/`;
  const now = new Date();
  // why: settle every write before clearing the prefix, or a straggler re-creates it
  const settled = await Promise.allSettled(
    files.map(async (file) => {
      const storageKey = `${prefix}${nanoid()}`;
      await getStorage().put(
        storageKey,
        Buffer.from(file.data),
        SKILL_FILE_CONTENT_TYPE,
      );
      return {
        id: nanoid(),
        skillId,
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        isText: file.isText,
        storageKey,
        createdAt: now,
      };
    }),
  );

  const rows: SkillFileRow[] = [];
  let failure: { error: unknown } | null = null;
  for (const result of settled) {
    if (result.status === "rejected") {
      failure ??= { error: result.reason };
    } else {
      rows.push(result.value);
    }
  }

  if (failure) {
    await deleteStoredPrefix(prefix);
    throw failure.error;
  }
  return { prefix, rows };
};

const readRequiredSkillFile = async (file: SkillFileRow): Promise<Buffer> => {
  const data = await readStoredSkillFile(file);
  if (!data) throw new Error(`Skill file missing: ${file.path}`);
  return data;
};

export const copySkillFilesTo = async (
  orgId: string,
  skillId: string,
  source: SkillFileRow[],
): Promise<{
  prefix: string;
  rows: SkillFileRow[];
  needsSandbox: boolean;
}> => {
  const files = await Promise.all(
    source.map(async (file) => ({
      path: file.path,
      data: await readRequiredSkillFile(file),
      size: file.size,
      sha256: file.sha256,
      isText: file.isText,
    })),
  );
  return {
    ...(await storeFiles(orgId, skillId, files)),
    needsSandbox: bundleNeedsSandbox(files),
  };
};

export type GithubInstallOrigin = {
  source: string;
  ref: string | null;
  skillPath: string;
  commitSha: string;
};

const NO_SOURCE = {
  sourceType: null,
  source: null,
  ref: null,
  skillPath: null,
  commitSha: null,
  installedHash: null,
};

export async function importSkillBundle(
  scope: SkillScope,
  zip: Uint8Array,
): Promise<SkillRow> {
  return createSkillFromBundle(scope, parseSkillZip(zip));
}

export async function createSkillFromBundle(
  scope: SkillScope,
  bundle: ParsedSkillBundle,
  github?: GithubInstallOrigin,
): Promise<SkillRow> {
  const hash = bundleHash(bundle);
  const id = nanoid();
  const { prefix, rows } = await storeFiles(orgIdOf(scope), id, bundle.files);
  try {
    return await db.transaction(async (tx) => {
      const row = oneRow(
        await tx
          .insert(skillTable)
          .values({
            id,
            ...bundle.fields,
            frontmatter: bundle.frontmatter,
            bundleHash: hash,
            needsSandbox: bundleNeedsSandbox(bundle.files),
            ...scopeColumnsOf(scope),
            ...(github && {
              sourceType: "github",
              ...github,
              installedHash: hash,
            }),
          })
          .returning(),
      );
      if (rows.length > 0) await tx.insert(skillFileTable).values(rows);
      return row;
    });
  } catch (error) {
    await deleteStoredPrefix(prefix);
    throw error;
  }
}

const uploadPrefixesOf = (rows: { storageKey: string }[]) =>
  new Set(
    rows.map(({ storageKey }) =>
      storageKey.slice(0, storageKey.lastIndexOf("/") + 1),
    ),
  );

export async function replaceSkillBundle(
  scope: SkillScope,
  skillId: string,
  zip: Uint8Array,
): Promise<SkillRow> {
  const where = await writableSkillWhere(scope, skillId);
  return swapSkillBundle(scope, skillId, where, parseSkillZip(zip), NO_SOURCE);
}

export async function updateSkillBundleFromGithub(
  scope: SkillScope,
  skillId: string,
  bundle: ParsedSkillBundle,
  commitSha: string,
): Promise<SkillRow> {
  const where = await writableSkillWhere(scope, skillId);
  return swapSkillBundle(scope, skillId, where, bundle, {
    commitSha,
    installedHash: bundleHash(bundle),
  });
}

async function swapSkillBundle(
  scope: SkillScope,
  skillId: string,
  where: SQL,
  bundle: ParsedSkillBundle,
  source: typeof NO_SOURCE | { commitSha: string; installedHash: string },
): Promise<SkillRow> {
  const { prefix, rows } = await storeFiles(
    orgIdOf(scope),
    skillId,
    bundle.files,
  );
  let replaced: { row: SkillRow; old: SkillFileRow[] };
  try {
    replaced = await db.transaction(async (tx) => {
      const old = await tx
        .delete(skillFileTable)
        .where(eq(skillFileTable.skillId, skillId))
        .returning();
      const [row] = await tx
        .update(skillTable)
        .set({
          ...bundle.fields,
          frontmatter: bundle.frontmatter,
          bundleHash: bundleHash(bundle),
          needsSandbox: bundleNeedsSandbox(bundle.files),
          ...source,
          updatedAt: new Date(),
        })
        .where(where)
        .returning();
      if (!row) throw new NotFoundError("Skill not found");
      if (rows.length > 0) await tx.insert(skillFileTable).values(rows);
      return { row, old };
    });
  } catch (error) {
    await deleteStoredPrefix(prefix);
    throw error;
  }

  for (const old of uploadPrefixesOf(replaced.old)) {
    await deleteStoredPrefix(old);
  }
  return replaced.row;
}

export const readStoredSkillFile = async (
  file: SkillFileRow,
): Promise<Buffer | null> =>
  (await getStorage().get(file.storageKey))?.data ?? null;

export async function exportSkillBundle(row: SkillRow): Promise<Uint8Array> {
  const files = await Promise.all(
    (await listSkillFiles(db, row.id)).map(async (file) => ({
      path: file.path,
      data: await readRequiredSkillFile(file),
    })),
  );
  return buildSkillZip({
    fields: fieldsOf(row),
    frontmatter: row.frontmatter,
    files,
  });
}

export const requireSkillFile = async (
  skillId: string,
  fileId: string,
): Promise<SkillFileRow> => {
  const [file] = await db
    .select()
    .from(skillFileTable)
    .where(
      and(eq(skillFileTable.skillId, skillId), eq(skillFileTable.id, fileId)),
    )
    .limit(1);
  if (!file) throw new NotFoundError("Skill file not found");
  return file;
};

export const findSkillFileByPath = async (
  skillId: string,
  path: string,
): Promise<SkillFileRow | undefined> => {
  const [file] = await db
    .select()
    .from(skillFileTable)
    .where(
      and(eq(skillFileTable.skillId, skillId), eq(skillFileTable.path, path)),
    )
    .limit(1);
  return file;
};

export const downloadSkillFile = async (
  skillId: string,
  fileId: string,
): Promise<{ data: Buffer; filename: string }> => {
  const file = await requireSkillFile(skillId, fileId);
  const data = await readStoredSkillFile(file);
  if (!data) throw new Error(`Skill file missing: ${file.path}`);
  return { data, filename: file.path.slice(file.path.lastIndexOf("/") + 1) };
};

export const skillFilesForApi = async (skillId: string) =>
  (await listSkillFiles(db, skillId)).map(
    ({ id, path, size, sha256, isText }) => ({
      id,
      path,
      size,
      sha256,
      isText,
    }),
  );
